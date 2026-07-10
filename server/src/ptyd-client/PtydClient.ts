import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  type CtrlMessage,
  type CtrlMethods,
  decodeMessage,
  encodeRequest,
} from '../ptyd/protocol.js';
import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';

export interface PtydClientOptions {
  socketPath: string;
  /**
   * Initial reconnect delay in ms. Doubled after each failed attempt up to
   * `maxBackoffMs`. Exposed for tests; production callers should leave it
   * at the default (200ms → 2s cap).
   */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

/**
 * Client-side wrapper around ptyd's `/control` channel. Manages a single
 * persistent WS, transparently reconnecting with exponential backoff. The
 * 8 control RPCs are exposed as async methods; the 5 push events are
 * re-emitted verbatim as EventEmitter events.
 *
 * RPC failure semantics: if the underlying socket isn't `OPEN`, calls
 * fail-fast with `Error('ptyd disconnected')`. We deliberately don't queue
 * across disconnects — the caller decides whether to retry.
 *
 * Events:
 *  - 'connected' / 'disconnected' — WS lifecycle (synthetic; emitted on
 *    every open/close including reconnects). 'disconnected' carries the
 *    last WS 'error' as payload (`Error | null`) when one was observed
 *    before the close.
 *  - 'paneExit' / 'paneCwd' / 'paneTitle' / 'paneFg' / 'paneAttention' /
 *    'paneActivity' / 'paneUrlsSeen' — forwarded from ptyd's control-event frames. Payload is
 *    the rest of the event object minus `event` (e.g. for paneExit:
 *    `{id, code, cause}`; for paneUrlsSeen: `{id, urls, markers}`).
 */
export class PtydClient extends EventEmitter {
  readonly socketPath: string;
  /**
   * `true` once the underlying WS has reached the OPEN state at least once
   * AND is currently open. Cleared on every 'close'. Exposed so callers
   * can do quick "is it safe to call?" checks without subscribing to
   * 'connected'/'disconnected'.
   */
  connected = false;

  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private closeWaiters: Array<() => void> = [];
  private lastError: Error | null = null;

  constructor(opts: PtydClientOptions) {
    super();
    this.socketPath = opts.socketPath;
    this.initialBackoffMs = opts.initialBackoffMs ?? 200;
    this.maxBackoffMs = opts.maxBackoffMs ?? 2000;
    this.backoffMs = this.initialBackoffMs;
    this.connect();
  }

  /**
   * Spawn or no-op a pane on ptyd. Resolves once ptyd has registered the
   * runtime (which is synchronous on its side; the PTY itself spawns
   * asynchronously and surfaces through paneCwd / paneFg events).
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async ensurePane(spec: PaneRuntimeSpec): Promise<void> {
    await this.call('ensurePane', { spec });
  }

  /**
   * Kill a pane. Resolves only after ptyd has confirmed the runtime is
   * gone (ptyd awaits PTY exit before responding).
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async killPane(id: string): Promise<void> {
    await this.call('killPane', { id });
  }

  /** Live pane ids in ptyd (throws on pre-listPanes ptyd builds). */
  async listPanes(): Promise<string[]> {
    const r = await this.call('listPanes', {});
    const ids = (r as { ids?: unknown }).ids;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  }

  /**
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async hasPane(id: string): Promise<boolean> {
    const r = await this.call('hasPane', { id });
    return r.has;
  }

  /**
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async getCurrentCwd(id: string): Promise<string | null> {
    const r = await this.call('getCurrentCwd', { id });
    return r.cwd;
  }

  /**
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async getForegroundCommand(id: string): Promise<string | null> {
    const r = await this.call('getForegroundCommand', { id });
    return r.cmd;
  }

  /**
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async markSeen(id: string): Promise<void> {
    await this.call('markSeen', { id });
  }

  /**
   * Returns ptyd's current snapshot of every live runtime's cwd.
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async flushCwds(): Promise<Array<{ id: string; cwd: string }>> {
    const r = await this.call('flushCwds', {});
    return r.entries;
  }

  /**
   * Force-close any /pty/:id sockets ptyd is holding for `id`. No-op when
   * there are none.
   * @throws Error('ptyd disconnected') if the socket isn't OPEN.
   */
  async closePtyClients(id: string): Promise<void> {
    await this.call('closePtyClients', { id });
  }

  /**
   * Stop reconnecting and tear down the current socket. Idempotent — a
   * second call resolves immediately. Pending RPCs are rejected with
   * `Error('ptyd disconnected')` before the promise resolves.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending(new Error('ptyd disconnected'));
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      try {
        ws.terminate();
      } catch {
        // already torn down; the 'close' listener above will still fire
        // (ws normalizes terminate-after-close to a no-op + synthetic close)
        resolve();
      }
    });
  }

  // --- internals ---

  private call<M extends keyof CtrlMethods>(
    method: M,
    params: CtrlMethods[M]['params'],
  ): Promise<CtrlMethods[M]['result']> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('ptyd disconnected'));
    }
    const id = ++this.nextId;
    return new Promise<CtrlMethods[M]['result']>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.ws!.send(encodeRequest({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private connect(): void {
    if (this.closed) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      // Already connecting / connected; nothing to do.
      return;
    }
    const ws = new WebSocket(`ws+unix://${this.socketPath}:/control`);
    this.ws = ws;
    ws.on('open', () => {
      this.backoffMs = this.initialBackoffMs;
      this.connected = true;
      this.lastError = null;
      this.emit('connected');
    });
    ws.on('message', (data: Buffer) => {
      this.handleMessage(data);
    });
    ws.on('error', (err: Error) => {
      // 'close' is guaranteed to follow; let that path drive cleanup so
      // we don't double-fail pending RPCs. Capture the error so the
      // 'disconnected' emit can surface it to consumers — without this,
      // operators can't distinguish "wrong socket path" from "ptyd crashed".
      this.lastError = err;
    });
    ws.on('close', () => {
      this.connected = false;
      this.failPending(new Error('ptyd disconnected'));
      // Always emit 'disconnected' on close, even if we never reached
      // 'open' — consumers want a single signal to wait on regardless of
      // whether the very first connect succeeded. Payload carries the
      // last WS 'error' (if any) so callers can diagnose the failure.
      const err = this.lastError;
      this.lastError = null;
      this.emit('disconnected', err);
      if (this.closed) return;
      const delay = Math.min(this.backoffMs, this.maxBackoffMs);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    });
  }

  private handleMessage(data: Buffer): void {
    let msg: CtrlMessage;
    try {
      msg = decodeMessage(data.toString());
    } catch {
      // Malformed frame from ptyd; nothing we can do except drop it.
      return;
    }
    if (msg.kind === 'response') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
      return;
    }
    if (msg.kind === 'event') {
      // Strip both `kind` and `event` from the payload — consumers want
      // just the event-specific fields (e.g. {id, code, cause} for paneExit).
      const {
        kind: _kind,
        event,
        ...payload
      } = msg as { kind: string; event: string } & Record<string, unknown>;
      this.emit(event, payload);
      return;
    }
    // Requests from ptyd are not part of the protocol; ignore.
  }

  private failPending(err: Error): void {
    if (this.pending.size === 0) return;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }
}
