import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { TranscriptSubscriptions } from '../ptyd/transcript-subscriptions.js';
import { type LinkUp, decodeLink, encodeLink, hostMaySend } from './link-protocol.js';
import { sendPath } from './send-files.js';

/**
 * THE HOST'S END OF THE LINK.
 *
 * One socket, dialled by the server, carrying three conversations (see
 * link-protocol.ts). This class owns what happens on this machine for each.
 *
 * ── THE RUNNER CHANNEL IS THE LOAD-BEARING ONE ───────────────────────────
 * An agent runner in a pane dials `MUXPAD_API_URL`, which for a remote pane
 * points at THIS agent rather than the server. The agent accepts that
 * connection and relays its frames up the link; the server's sends come back
 * down and are written to the runner. The server sees a runner exactly as it
 * sees a local one.
 *
 * It is also where this machine learns a chat's SESSION ID. The runner's
 * `hello` carries `sid`, and that is the only place the id exists before
 * anything is written to disk — the server cannot supply it, because every
 * path that records a sid (`register`, `/hook`, `hello`) travels host→server.
 * So the hello is snooped on the way past and cached, which is what lets the
 * transcript channel resolve a pane at all.
 *
 * ── ONE RUNNER PER PANE, NEWEST WINS ─────────────────────────────────────
 * Same rule the server applies locally, for the same reason: a respawn can
 * connect before the old socket's close fires, and two runners trading the
 * registration would strobe the chat's status forever.
 */

export interface LinkServerDeps {
  /** Open a socket to this host's local ptyd control endpoint. */
  connectPtyd: () => WebSocket;
  /** Build a transcript tail. See TranscriptSubscriptions. */
  makeTail: ConstructorParameters<typeof TranscriptSubscriptions>[0]['makeTail'];
  log?: (line: string) => void;
}

export class LinkServer {
  private link: WebSocket | null = null;
  private ptyd: WebSocket | null = null;
  private readonly runners = new Map<string, WebSocket>();
  /** pane → session, learned from each runner's own `hello`. */
  private readonly sids = new Map<string, { sid: string; assistant: string }>();
  /**
   * The last `hello` each runner sent, verbatim.
   *
   * REPLAYED WHEN A SERVER (RE)CONNECTS. A runner sends hello once, when it
   * starts. If the server restarts afterwards, its socket to US never
   * dropped — so it has no reason to send another, and the server would
   * register a runner it knows nothing about: no session id, and a chat view
   * that spins on "Starting…" forever over a runner that is attached and
   * answering.
   *
   * Replaying is the host's job because the host is the only side that still
   * has it. Cheap: one small object per live runner.
   */
  private readonly lastHello = new Map<string, string>();
  /**
   * In-flight `api` calls, by correlation id.
   *
   * ALWAYS SETTLED. The caller is a shell script blocking on curl inside a
   * chat, so a dropped answer is not a lost request — it is a conversation
   * that appears to freeze. Every path here (a response, a link that went
   * away, a timeout) resolves exactly one of these.
   */
  private readonly apiCalls = new Map<
    string,
    (r: { status: number; body: string; contentType?: string }) => void
  >();
  private readonly subs: TranscriptSubscriptions;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: LinkServerDeps) {
    this.log = deps.log ?? ((l) => console.log(l));
    this.subs = new TranscriptSubscriptions({
      resolveSid: (paneId) => this.sids.get(paneId) ?? null,
      makeTail: deps.makeTail,
      push: (e) => this.up(e as unknown as LinkUp),
    });
  }

  /** Frames to the server. Dropped when no link is up — the server
   *  re-subscribes and the runner reconnects, so silence is recoverable and
   *  buffering a dead link is not. */
  private up(m: LinkUp): void {
    if (!hostMaySend(m)) {
      // A bug on this side, not an attack: say so loudly rather than sending
      // something the server will refuse.
      this.log(`[link] refusing to send a server-only message: ${JSON.stringify(m).slice(0, 80)}`);
      return;
    }
    if (this.link?.readyState === WebSocket.OPEN) this.link.send(encodeLink(m));
  }

  /** The server connected. */
  attachLink(ws: WebSocket): void {
    this.link?.close();
    this.link = ws;
    // ptyd passthrough: one socket per link, opened lazily so an agent with no
    // server attached holds nothing open.
    const ptyd = this.deps.connectPtyd();
    this.ptyd = ptyd;
    ptyd.on('message', (d) => this.up({ ch: 'ptyd', payload: d.toString() }));
    ptyd.on('close', () => {
      if (this.ptyd === ptyd) this.ptyd = null;
    });
    ptyd.on('error', (e) => this.log(`[link] ptyd error: ${(e as Error).message}`));

    ws.on('message', (d) => this.onDown(d.toString()));
    ws.on('close', () => {
      if (this.link !== ws) return;
      this.link = null;
      // Subscriptions belonged to a server that is no longer listening; their
      // pushes would go nowhere. It re-subscribes for whatever is still being
      // viewed, which is why subscribe is idempotent.
      this.subs.closeAll();
      // Nothing will ever answer these now; a 503 is the truth and silence is
      // a hung pane.
      this.failAllApi('the control plane is not connected');
      try {
        ptyd.close();
      } catch {}
      this.log('[link] server disconnected');
    });
    this.log('[link] server connected');
    // Tell it about every runner already here, so a reconnect re-registers
    // them without waiting for the next turn.
    for (const paneId of this.runners.keys()) {
      this.up({ ch: 'runner', op: 'attached', paneId });
      // …and the hello it sent before this server existed, so the session is
      // registered rather than merely connected. Ordered after `attached` so
      // the far side has opened (or is opening) its relay; it buffers frames
      // that arrive first.
      const hello = this.lastHello.get(paneId);
      if (hello) {
        try {
          this.up({ ch: 'runner', op: 'frame', paneId, frame: JSON.parse(hello) });
        } catch {
          /* cached text is always something we parsed once */
        }
      }
    }
  }

  private onDown(raw: string): void {
    const m = decodeLink(raw);
    if (!m) return; // malformed closes a message, never the process
    if (m.ch === 'ptyd') {
      if (this.ptyd?.readyState === WebSocket.OPEN) this.ptyd.send(m.payload);
      return;
    }
    if (m.ch === 'transcript') {
      if (m.op === 'subscribe') this.subs.subscribe(m.paneId, m.tailBytes);
      else if (m.op === 'unsubscribe') this.subs.unsubscribe(m.paneId);
      else if (m.op === 'loadOlder') this.subs.loadOlder(m.paneId);
      return;
    }
    if (m.ch === 'files') {
      // Only ever in response to the server naming a path — see send-files.ts
      // on why this direction is a pull.
      if (m.op === 'fetch') void this.sendFiles(m.id, m.path);
      return;
    }
    if (m.ch === 'api') {
      if (m.op !== 'response') return;
      const settle = this.apiCalls.get(m.id);
      if (!settle) return; // already timed out; its caller has an answer
      this.apiCalls.delete(m.id);
      settle({
        status: m.status,
        body: m.body,
        ...(m.contentType ? { contentType: m.contentType } : {}),
      });
      return;
    }
    if (m.op === 'frame') {
      const r = this.runners.get(m.paneId);
      if (r?.readyState === WebSocket.OPEN) r.send(JSON.stringify(m.frame));
    }
  }

  /**
   * Stream one path to the server, for a publish from a chat on this machine.
   *
   * ALWAYS TERMINATES with a `done` or an `error`: the far side is holding a
   * staging directory and an HTTP request open, so a transfer that simply
   * stops is a publish that hangs and a temp dir that never gets swept.
   */
  private async sendFiles(id: string, path: string): Promise<void> {
    await sendPath(path, {
      chunk: (rel, b64, last) => this.up({ ch: 'files', op: 'chunk', id, rel, b64, last }),
      done: (kind, name) => this.up({ ch: 'files', op: 'done', id, kind, name }),
      error: (reason) => this.up({ ch: 'files', op: 'error', id, reason }),
    });
  }

  /**
   * Ask the control plane to answer one in-pane CLI call.
   *
   * The host does not decide what is allowed — the server's allowlist does,
   * because that is where the principal lives (which machine asked) and where
   * the ids can be checked against the pane table. This side is a pipe with a
   * timeout, deliberately: duplicating the policy here would mean two places
   * to keep in sync and a host that could be lied to about its own rights.
   */
  callApi(
    method: string,
    path: string,
    body: string | undefined,
    timeoutMs = 15_000,
  ): Promise<{ status: number; body: string; contentType?: string }> {
    if (this.link?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        status: 503,
        body: JSON.stringify({ error: 'the control plane is not connected' }),
        contentType: 'application/json',
      });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.apiCalls.delete(id)) return;
        resolve({
          status: 504,
          body: JSON.stringify({ error: 'the control plane did not answer in time' }),
          contentType: 'application/json',
        });
      }, timeoutMs);
      timer.unref?.();
      this.apiCalls.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.up({
        ch: 'api',
        op: 'request',
        id,
        method,
        path,
        ...(body === undefined ? {} : { body }),
      });
    });
  }

  private failAllApi(why: string): void {
    for (const [, settle] of this.apiCalls) {
      settle({
        status: 503,
        body: JSON.stringify({ error: why }),
        contentType: 'application/json',
      });
    }
    this.apiCalls.clear();
  }

  /**
   * A runner on this machine connected for `paneId`.
   *
   * NEWEST WINS, closing the previous with 4001 — the same code and the same
   * reason as the server's local path: a displaced runner that is still a live
   * process must exit rather than reconnect, or the two trade the registration
   * forever.
   */
  attachRunner(paneId: string, ws: WebSocket): void {
    // ORDER MATTERS. Register the successor FIRST, then close the old one.
    // `close()` can fire its handler synchronously, and that handler reports a
    // detach unless it sees itself already replaced — so closing first makes a
    // displacement look like the pane's runner going away, deregistering the
    // live successor. In production the close is usually async, and "usually"
    // is exactly how a strobing-status bug gets shipped.
    const previous = this.runners.get(paneId);
    this.runners.set(paneId, ws);
    previous?.close(4001, 'displaced by a newer runner');
    this.up({ ch: 'runner', op: 'attached', paneId });

    ws.on('message', (d) => {
      const text = d.toString();
      this.snoopSid(paneId, text);
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return; // the server validates frames; a malformed one is not relayed
      }
      this.up({ ch: 'runner', op: 'frame', paneId, frame });
    });
    ws.on('close', () => {
      if (this.runners.get(paneId) !== ws) return; // displaced, not gone
      this.runners.delete(paneId);
      this.lastHello.delete(paneId);
      this.up({ ch: 'runner', op: 'detached', paneId });
    });
    ws.on('error', () => {
      /* close fires alongside */
    });
  }

  /**
   * Learn this pane's session id from its runner's `hello`.
   *
   * The only place that id exists before anything is written, and the server
   * cannot tell us — every path that records a sid travels host→server. Read
   * on the way past rather than requested, so there is no round trip between
   * a chat starting and its history being tailable.
   */
  private snoopSid(paneId: string, text: string): void {
    try {
      const f = JSON.parse(text) as { t?: string; sid?: string; backend?: string };
      if (f.t !== 'hello' || typeof f.sid !== 'string' || !f.sid) return;
      const prev = this.sids.get(paneId);
      this.sids.set(paneId, { sid: f.sid, assistant: f.backend ?? 'claude' });
      this.lastHello.set(paneId, text);
      // A hello with a NEW sid means the session rotated (a /clear, a resume
      // onto a different id). Re-tail, or the chat would keep showing the old
      // conversation. Only when something is actually subscribed.
      if (prev && prev.sid !== f.sid && this.subs.count() > 0) this.subs.subscribe(paneId);
    } catch {
      /* not JSON, not a hello */
    }
  }

  /** Live counts, for a health line and for tests. */
  stats(): { runners: number; subscriptions: number; linked: boolean } {
    return {
      runners: this.runners.size,
      subscriptions: this.subs.count(),
      linked: this.link?.readyState === WebSocket.OPEN,
    };
  }

  close(): void {
    this.failAllApi('this host agent is shutting down');
    this.subs.closeAll();
    for (const [, r] of this.runners) r.close();
    this.runners.clear();
    this.link?.close();
    this.ptyd?.close();
  }
}

/** Route an upgrade to the link or to a runner. Exported for the agent. */
export function linkUpgradeKind(
  path: string,
): { kind: 'link' } | { kind: 'runner'; paneId: string } | null {
  if (path === '/link') return { kind: 'link' };
  const m = /^\/ws\/agent-runner\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  return m ? { kind: 'runner', paneId: m[1] as string } : null;
}
