import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { TranscriptSubscriptions } from '../ptyd/transcript-subscriptions.js';
import { type LinkUp, decodeLink, encodeLink, hostMaySend } from './link-protocol.js';
import { sign } from './origin-proof.js';
import { sendPath } from './send-files.js';

/** One call this host is relaying, remembered only while it is in flight. */
interface InFlightCall {
  /** What the in-pane CLI said the call is for — `slack.post`, `msgvault.search`. */
  action: string;
  /** Every value the call actually carried, stringified. The host refuses to
   *  sign a payload that does not contain all of them. */
  values: string[];
}

/** `pane` and `key` identify the caller, not the request, and never reach the
 *  broker payload — binding on them would refuse every honest signature. */
const NOT_THE_REQUEST = new Set(['pane', 'key']);

/** One stringified form for both sides, so a number in a query string and a
 *  number in a payload compare equal. Objects and arrays get a stable
 *  serialisation; key order must not decide whether a proof is issued.
 *
 *  Anything long is reduced to a digest. `slack.upload` carries ~14MB of
 *  base64, and holding a second copy of it for the lifetime of the call —
 *  then hashing it twice to compare — is a real cost for a check whose only
 *  job is equality. A digest compares exactly the same and is 71 bytes. */
const LONG = 256;
const asValue = (v: unknown): string => {
  const raw = v !== null && typeof v === 'object' ? JSON.stringify(stableValue(v)) : String(v);
  return raw.length > LONG ? `sha256:${createHash('sha256').update(raw).digest('hex')}` : raw;
};

const stableValue = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stableValue);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stableValue((v as Record<string, unknown>)[k])]),
    );
  return v;
};

/** What a relayed call carries, from either place it can carry it: the query
 *  string of a GET or the JSON body of a POST. Empty values bind nothing and
 *  are dropped — requiring `""` to appear would be a rule about nothing. */
export function callValues(path: string, body: string | undefined): string[] {
  const out: string[] = [];
  const query = path.includes('?') ? new URLSearchParams(path.slice(path.indexOf('?') + 1)) : null;
  if (query)
    for (const [k, v] of query) if (!NOT_THE_REQUEST.has(k) && v !== '') out.push(asValue(v));
  if (body)
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
          if (!NOT_THE_REQUEST.has(k) && v !== '' && v !== undefined) out.push(asValue(v));
    } catch {
      // A body this host cannot parse binds nothing, and the signature then
      // rests on the action alone — the behaviour before this existed.
    }
  return out;
}

/** The values a payload offers, flattened one level: the broker's payloads
 *  are flat objects of scalars and small arrays, and a nested match would
 *  invite a payload that buries the real value somewhere it is not used. */
export function payloadValues(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.values(payload as Record<string, unknown>).map(asValue);
}

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
  /**
   * Search THIS machine's archive, for the server's cross-host view.
   *
   * Optional: a host with no archive answers "no index here" rather than
   * pretending to have searched, which is a different fact from "no hits" and
   * the server renders it as such.
   */
  search?: (
    q: string,
    opts: { limit: number; role?: string },
  ) => {
    hits: unknown[];
    fallback: boolean;
  };
  /** Build a transcript tail. See TranscriptSubscriptions. */
  makeTail: ConstructorParameters<typeof TranscriptSubscriptions>[0]['makeTail'];
  /**
   * THIS MACHINE'S ORIGIN KEY, and the name it signs as.
   *
   * Absent on a host with no key, which is the normal state and not an error:
   * every connector call from here is then approved once, exactly as before.
   * Read per signature rather than cached, so rotating the file takes effect
   * without restarting the agent — a restart here drops every pane's link.
   */
  originKey?: () => { origin: string; key: string } | null;
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
  /**
   * What the in-pane CLI said each in-flight call is FOR.
   *
   * The server asks this host to sign the action it is about to send to the
   * broker; without this the host would have to take the server's word for
   * what the call was, and a server that had been taken over could turn a
   * `slack.channels` somebody is relaying into a `slack.post`. Keyed by the
   * same correlation id as `apiCalls`, and dropped with it.
   */
  private readonly apiActions = new Map<string, InFlightCall>();
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
    if (m.ch === 'search') {
      if (m.op === 'query') this.answerSearch(m.id, m.q, m.limit, m.role);
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
    if (m.ch === 'origin') {
      if (m.op === 'sign') this.signOrigin(m.id, m.callId, m.action, m.payload);
      return;
    }
    if (m.op === 'frame') {
      const r = this.runners.get(m.paneId);
      if (r?.readyState === WebSocket.OPEN) r.send(JSON.stringify(m.frame));
    }
  }

  /**
   * Prove that THIS machine is asking, for one call it is relaying.
   *
   * ALWAYS answers, and an answer of "no" is normal: no key here, the call is
   * not in flight, or the action is not the one the caller asked for. The
   * server then sends the broker request unproven and a human approves it
   * once — which is where everything stood before this existed, and the right
   * failure for a key that has been rotated on one side only.
   *
   * The three checks are the whole security argument:
   *
   *   · IN FLIGHT — the host signs only for a call it is itself relaying, so
   *     a server cannot collect signatures for requests nobody made;
   *   · THE DECLARED ACTION — the host signs what its own caller asked for,
   *     so a server cannot upgrade a read it is relaying into a write;
   *   · AND THE VALUES — every value this host actually relayed has to be in
   *     the payload it is being asked to sign.
   *
   * The third one was missing, and without it the second was worth less than
   * its comment claimed. "The host signs what its own caller asked for" was
   * true of the ACTION and false of the REQUEST: any payload at all could be
   * signed while some call for that action was in flight. A `msgvault.search`
   * the VM ran for "dinner" would mint a proof for a search of anything, and
   * a `slack.post` to one channel would mint a proof for a post to another.
   * That matters because a proof is what lets a timed grant be SPENT — so
   * whoever can drive this link could ride a grant with a request this
   * machine never made.
   *
   * Binding is by VALUE rather than by key, because the server legitimately
   * renames and adds: `?q=` becomes `{query}`, `?limit=25` becomes a number,
   * and absent options arrive as defaults like `all: false`. Requiring every
   * relayed value to appear among the payload's own values survives all of
   * that and still pins the fields that carry meaning — the query, the id,
   * the channel, the text.
   *
   * A wrong refusal here is SAFE and that is why the rule can be strict: an
   * unproven request is approved once by a human, which is where everything
   * stood before proofs existed. The failure mode is a dialog, never a
   * broken call.
   */
  private signOrigin(id: string, callId: string, action: string, payload: unknown): void {
    const refuse = (reason: string): void => {
      this.up({ ch: 'origin', op: 'unavailable', id, reason });
    };
    const identity = this.deps.originKey?.() ?? null;
    if (!identity) {
      refuse('no origin key on this host');
      return;
    }
    const call = this.apiActions.get(callId);
    if (!call) {
      refuse('no such call in flight');
      return;
    }
    if (call.action !== action) {
      refuse(`call is for ${call.action}, not ${action}`);
      return;
    }
    const offered = new Set(payloadValues(payload));
    const missing = call.values.find((v) => !offered.has(v));
    if (missing !== undefined) {
      // The value itself is NOT named in the reason: it is the user's search
      // text or message body, and this string is relayed to the other
      // machine and logged there.
      refuse('payload does not match the call this host relayed');
      return;
    }
    const ts = Date.now();
    const nonce = randomUUID();
    const sig = sign(identity.key, { origin: identity.origin, action, payload, ts, nonce });
    this.up({ ch: 'origin', op: 'signed', id, proof: { ts, nonce, sig } });
  }

  /**
   * Answer one search of this machine's archive.
   *
   * ALWAYS answers. The server is holding an HTTP request open for a user
   * looking at a search box, and the whole value of a cross-host result is
   * knowing which machines actually reported — so "I have no index" and "the
   * query failed" are said out loud rather than becoming a silent gap that
   * reads as "nothing here".
   */
  private answerSearch(id: string, q: string, limit: number, role?: string): void {
    const search = this.deps.search;
    if (!search) {
      this.up({ ch: 'search', op: 'error', id, reason: 'no archive on this machine' });
      return;
    }
    try {
      const { hits, fallback } = search(q, { limit, ...(role ? { role } : {}) });
      this.up({ ch: 'search', op: 'hits', id, hits, fallback });
    } catch (e) {
      this.up({ ch: 'search', op: 'error', id, reason: (e as Error).message });
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
    /** What the caller says this call is for — `slack.post`, `msgvault.search`.
     *  A label from the in-pane CLI, used for ONE thing: refusing to sign an
     *  action the caller did not ask for. */
    declaredAction?: string,
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
        this.apiActions.delete(id);
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
        this.apiActions.delete(id);
        resolve(r);
      });
      if (declaredAction)
        this.apiActions.set(id, { action: declaredAction, values: callValues(path, body) });
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
    this.apiActions.clear();
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
