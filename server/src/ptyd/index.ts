import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { unlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PaneManager } from '../runtime/PaneManager.js';
import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';
import {
  decodeMessage, encodeResponse, encodeErrorResponse, encodeEvent,
  type CtrlMessage, type CtrlPushEvent,
} from './protocol.js';
import { attachPty } from './pty-bridge.js';

export interface PtydOptions {
  socketPath: string;
  /**
   * Override PaneManager's cwd polling cadence. Tests use a short value
   * (~50ms) to observe `paneCwd` events inside their timeout. Falls back
   * to PaneManager's own default (30s) when omitted.
   */
  cwdPollInterval?: number;
  /** Override PaneManager's fg-cmd polling cadence. Tests / advanced use. */
  cmdPollInterval?: number;
  /**
   * Liveness ping interval in ms (applies to every WS attached to ptyd —
   * both /control and /pty/:id). Defaults to 15s; tests can pass a small
   * value if they want to exercise the ghost-termination path. Mirrors
   * the `heartbeatMs` knob on the main server's ws.ts.
   */
  heartbeatMs?: number;
}
export interface PtydHandle { stop(): Promise<void>; }

export async function startPtyd(opts: PtydOptions): Promise<PtydHandle> {
  if (existsSync(opts.socketPath)) await unlink(opts.socketPath);
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  // Per-pane WS bucket for /pty/:id attachments. Used by the
  // closePtyClients RPC which iterates the bucket for a given pane id
  // and force-closes every socket. Populated/cleared by attachPty's
  // open/close handlers.
  const paneSockets = new Map<string, Set<WebSocket>>();
  // /control subscribers. broadcastEvent fans control events to *these*
  // sockets only — NOT every wss.client, because the wss is shared with
  // /pty/:id sockets and a JSON event frame would corrupt the binary
  // PTY protocol on the browser side.
  const controlSockets = new Set<WebSocket>();

  // Force-close every /pty/:id WS attached to `paneId` with WS close
  // code 4001 ("pane kind changed"). Mirrors the semantics of the
  // legacy in-process implementation in server/src/ws.ts. The attached
  // sockets' 'close' handlers in attachPty will also remove themselves
  // from the bucket; clearing here makes the subsequent removal a
  // harmless no-op (Set.delete on a missing key) and ensures a second
  // call sees an empty bucket immediately.
  function closePaneClients(paneId: string): void {
    const bucket = paneSockets.get(paneId);
    if (!bucket) return;
    for (const ws of bucket) {
      try {
        ws.close(4001, 'pane kind changed');
      } catch {
        // already closing; ignore
      }
    }
    bucket.clear();
    paneSockets.delete(paneId);
  }

  // Server-side liveness sweep. A WS severed abruptly (network blip,
  // dead client) doesn't fire 'close' until the OS TCP timeout, which
  // would otherwise leave ghost entries in PaneRuntime.connectedClients
  // and stale buckets in `paneSockets`. We ping every wss client on an
  // interval; any client that didn't pong since the previous round gets
  // terminated, firing 'close' → cleanup. Applies uniformly to both
  // /control and /pty/:id sockets.
  const HEARTBEAT_MS = opts.heartbeatMs ?? 15_000;
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const live = client as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        live.terminate();
        continue;
      }
      live.isAlive = false;
      try {
        live.ping();
      } catch {
        // socket already closing; the next sweep (or 'close') cleans up.
      }
    }
  }, HEARTBEAT_MS);

  // Broadcast a control-channel push event to every currently attached
  // /control client. The main server is expected to keep exactly one
  // persistent control connection, so this is effectively a unicast in
  // production. CRITICAL: only iterates controlSockets (not wss.clients)
  // because the wss is shared with binary /pty/:id sockets — sending a
  // JSON frame to a /pty/:id client corrupts the byte stream the browser
  // is decoding via the ws-protocol opcode header.
  function broadcastEvent(e: CtrlPushEvent): void {
    const frame = encodeEvent(e);
    for (const client of controlSockets) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(frame);
        } catch {
          // Drop — client will reconnect and resubscribe.
        }
      }
    }
  }

  // Spread the optional polling intervals so they're absent (not
  // `undefined`) when not provided — `exactOptionalPropertyTypes` is on.
  const paneManager = new PaneManager({
    ...(opts.cwdPollInterval !== undefined ? { cwdPollInterval: opts.cwdPollInterval } : {}),
    ...(opts.cmdPollInterval !== undefined ? { cmdPollInterval: opts.cmdPollInterval } : {}),
    onCwdChange: (id, cwd) => broadcastEvent({ event: 'paneCwd', id, cwd }),
    onPaneChange: (id, change) => {
      if (change.kind === 'title') {
        broadcastEvent({ event: 'paneTitle', id, title: change.title });
      } else if (change.kind === 'fg') {
        broadcastEvent({ event: 'paneFg', id, cmd: change.cmd });
      } else {
        broadcastEvent({ event: 'paneAttention', id, attention: change.attention });
      }
    },
    onPaneExit: (id, code, cause) =>
      broadcastEvent({ event: 'paneExit', id, code, cause }),
  });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/control') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Heartbeat bookkeeping: matches attachPty's pattern so /control
        // and /pty/:id participate uniformly in the wss-wide ping sweep.
        const live = ws as WebSocket & { isAlive?: boolean };
        live.isAlive = true;
        ws.on('pong', () => {
          live.isAlive = true;
        });
        ws.on('error', () => {
          // 'close' fires alongside; cleanup happens there. Swallow here so an
          // error on a single attach doesn't crash the daemon.
        });
        controlSockets.add(ws);
        ws.on('close', () => controlSockets.delete(ws));
        attachControl(ws, paneManager, closePaneClients);
      });
      return;
    }
    const ptyMatch = url.pathname.match(/^\/pty\/([^/]+)$/);
    if (ptyMatch) {
      const paneId = ptyMatch[1] as string;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const runtime = paneManager.get(paneId);
        if (!runtime) {
          // 4404 = app-defined "pane not found". Caller must have sent
          // ensurePane before attaching. Upgrade-then-close (rather than
          // socket.destroy pre-upgrade) so the client gets a clean WS
          // close event with the protocol-level code, not a raw TCP RST.
          ws.close(4404, 'pane not found');
          return;
        }
        attachPty({ ws, runtime, paneId, paneSockets });
      });
      return;
    }
    socket.destroy();
  });
  await new Promise<void>((r) => http.listen(opts.socketPath, r));
  // Lock down the socket regardless of umask — the only legitimate
  // consumer is the main muxpad server, which runs as the same user.
  // chmod is best-effort: on platforms where the socket is a TCP loopback
  // (not in current code paths) or if the path was deleted out from under
  // us, swallow the error so the daemon still starts.
  try {
    await chmod(opts.socketPath, 0o600);
  } catch {
    // ignore
  }
  return {
    async stop() {
      clearInterval(heartbeat);
      await paneManager.killAll();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => http.close(() => r()));
      if (existsSync(opts.socketPath)) await unlink(opts.socketPath).catch(() => {});
    },
  };
}

function attachControl(
  ws: WebSocket,
  pm: PaneManager,
  closePaneClients: (paneId: string) => void,
): void {
  ws.on('message', async (data: Buffer) => {
    let msg: CtrlMessage;
    try { msg = decodeMessage(data.toString()); }
    catch (e) { ws.send(encodeErrorResponse(0, String(e))); return; }
    if (msg.kind !== 'request') return;
    try {
      if (msg.method === 'hasPane') {
        const { id } = msg.params as { id: string };
        ws.send(encodeResponse(msg.id, { has: pm.has(id) }));
        return;
      }
      if (msg.method === 'ensurePane') {
        const { spec } = msg.params as { spec: PaneRuntimeSpec };
        // Fire-and-forget: getOrCreate is sync (PTY spawn happens inside
        // start()), and we don't hand back the runtime — callers observe
        // it via hasPane / events.
        pm.getOrCreate(spec);
        ws.send(encodeResponse(msg.id, { ok: true }));
        return;
      }
      if (msg.method === 'killPane') {
        const { id } = msg.params as { id: string };
        // pm.kill awaits PTY exit (with a 2s SIGKILL fallback). The response
        // is only sent after the runtime is gone, so callers can sequence a
        // follow-up hasPane and expect `has: false`.
        await pm.kill(id);
        ws.send(encodeResponse(msg.id, { ok: true }));
        return;
      }
      if (msg.method === 'getCurrentCwd') {
        const { id } = msg.params as { id: string };
        const cwd = pm.get(id)?.getCurrentCwd() ?? null;
        ws.send(encodeResponse(msg.id, { cwd }));
        return;
      }
      if (msg.method === 'getForegroundCommand') {
        const { id } = msg.params as { id: string };
        // PaneManager caches fg cmd via its 10s polling tick; this just
        // surfaces whatever it has (null until the first successful poll).
        ws.send(encodeResponse(msg.id, { cmd: pm.getForegroundCommand(id) }));
        return;
      }
      if (msg.method === 'markSeen') {
        const { id } = msg.params as { id: string };
        // Idempotent: optional-chain handles the unknown-id case as a no-op.
        pm.get(id)?.markSeen();
        ws.send(encodeResponse(msg.id, { ok: true }));
        return;
      }
      if (msg.method === 'closePtyClients') {
        const { id } = msg.params as { id: string };
        closePaneClients(id);
        ws.send(encodeResponse(msg.id, { ok: true }));
        return;
      }
      if (msg.method === 'flushCwds') {
        // snapshotCwds returns the *full* current set (every live runtime's
        // cwd), as opposed to pm.flushCwds() which only fires the onChange
        // hook for cwds that have shifted. Callers (the main server) want
        // the full set so they can persist whatever ptyd currently sees.
        ws.send(encodeResponse(msg.id, { entries: pm.snapshotCwds() }));
        return;
      }
      ws.send(encodeErrorResponse(msg.id, `unknown method: ${msg.method}`));
    } catch (e) {
      ws.send(encodeErrorResponse(msg.id, String(e)));
    }
  });
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const socketPath = process.env.MUXPAD_PTYD_SOCKET
    ?? `${process.env.HOME}/.muxpad/ptyd.sock`;
  startPtyd({ socketPath }).then(() => {
    console.log(`ptyd listening on ${socketPath}`);
  });
  process.on('SIGTERM', () => process.exit(0));
}
