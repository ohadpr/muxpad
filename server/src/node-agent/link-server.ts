import { WebSocket } from 'ws';
import { TranscriptSubscriptions } from '../ptyd/transcript-subscriptions.js';
import { type LinkUp, decodeLink, encodeLink, hostMaySend } from './link-protocol.js';

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
    if (m.op === 'frame') {
      const r = this.runners.get(m.paneId);
      if (r?.readyState === WebSocket.OPEN) r.send(JSON.stringify(m.frame));
    }
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
