import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { type LinkDown, type LinkUp, decodeLink, encodeLink } from '../node-agent/link-protocol.js';
import { FileReceiver } from './receive-files.js';

/**
 * THE SERVER'S END OF ONE HOST LINK.
 *
 * Dials `/link` on a host and carries the two things that cannot travel any
 * other way, because the host cannot open a connection to this machine:
 *
 *   runner     · a runner's frames come up; this server's sends go down.
 *   transcript · a remote chat's rendered history comes up.
 *
 * ── TWO SOCKETS PER HOST, DELIBERATELY ───────────────────────────────────
 * Pane operations keep their own `/control` dial (NodeLinks + PtydClient),
 * which is proven and carries ptyd's own pushes. Collapsing them onto this
 * socket would mean re-plumbing the one part that already works, for elegance.
 * The point of a single link was never the socket COUNT — it was that the
 * server dials and the host can still send, which this satisfies.
 *
 * ── RELAYED RUNNERS GO THROUGH LOOPBACK, AND WHY ─────────────────────────
 * A relayed runner is registered by opening a LOCAL WebSocket to this
 * server's own `/ws/agent-runner/:paneId` and piping frames through it.
 *
 * The alternative is extracting the runner-registration arm — 850 lines
 * inside the upgrade handler — into a function both paths call, which a trust
 * review preferred and which IS the better shape. It is not a change to make
 * in one pass on a live install.
 *
 * What loopback buys, beyond safety: the identity finally comes from
 * somewhere real. This server stamps `x-muxpad-node-id` on a connection IT
 * makes, which is exactly what an earlier comment in ws.ts claimed and could
 * not deliver, because nothing wrote that header. Now something does, and the
 * ownership check it guards becomes load-bearing instead of decorative.
 */

export interface HostLinkDeps {
  nodeId: string;
  /** `ws://host:7797` — `/link` is appended. */
  endpoint: string;
  token: string;
  /** This server's own base, for the loopback runner connection. */
  selfUrl: string;
  /**
   * The install credential, so the loopback upgrade satisfies api-auth.
   *
   * A FUNCTION, called at relay time. Read once at construction it was always
   * null: HostLinks.start() runs before initApiAuth(), so the secret did not
   * exist yet. Harmless while auth is in `observe` — the upgrade is allowed
   * and merely logged — and an instant, total failure the moment it is
   * enforced, which is the worst time to discover it.
   */
  apiKey: () => string | null;
  /**
   * One in-pane CLI call from this host, for the scoped allowlist to answer.
   *
   * Optional so a link can be constructed without the API surface at all —
   * which is what the transcript tests do, and what "the host gets nothing by
   * default" should look like in code.
   */
  onApiRequest?: (m: {
    method: string;
    path: string;
    body?: string;
  }) => Promise<{ status: number; body: string; contentType?: string }>;
  /** A remote chat's events arrived. */
  onTranscript: (m: {
    paneId: string;
    kind: 'events' | 'title' | 'unavailable';
    phase?: string;
    events?: unknown[];
    title?: string;
    reason?: string;
  }) => void;
  log?: (line: string) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * IS THIS FRAME SHAPED LIKE WHAT IT CLAIMS TO BE?
 *
 * Only the fields this side READS, and only for the ops a host may send.
 * Exported for its test: the interesting inputs are the ones a hostile peer
 * would send, and they are tedious to produce through a live socket.
 *
 * Deliberately not a schema library. The list is short, it sits at one
 * boundary, and the failure mode of getting it wrong (a dropped frame) is the
 * same as the failure mode of a malformed one — whereas the failure mode of
 * not having it was an uncaught TypeError taking down the install.
 */
export function wellFormed(m: LinkDown | LinkUp): boolean {
  const str = (v: unknown): boolean => typeof v === 'string';
  switch (m.ch) {
    case 'ptyd':
      return str((m as { payload?: unknown }).payload);
    case 'transcript': {
      const t = m as { op?: unknown; paneId?: unknown; events?: unknown; title?: unknown };
      if (!str(t.paneId)) return false;
      if (t.op === 'events') return Array.isArray(t.events);
      if (t.op === 'title') return str(t.title);
      if (t.op === 'unavailable') return str((t as { reason?: unknown }).reason);
      return false;
    }
    case 'runner': {
      const r = m as { op?: unknown; paneId?: unknown; frame?: unknown };
      if (!str(r.paneId)) return false;
      if (r.op === 'frame') return !!r.frame && typeof r.frame === 'object';
      return r.op === 'attached' || r.op === 'detached';
    }
    case 'api': {
      const a = m as {
        op?: unknown;
        id?: unknown;
        method?: unknown;
        path?: unknown;
        body?: unknown;
      };
      if (a.op !== 'request') return false;
      return str(a.id) && str(a.method) && str(a.path) && (a.body === undefined || str(a.body));
    }
    case 'files': {
      const f = m as { op?: unknown; id?: unknown; rel?: unknown; b64?: unknown; last?: unknown };
      if (!str(f.id)) return false;
      if (f.op === 'chunk') return str(f.rel) && str(f.b64) && typeof f.last === 'boolean';
      if (f.op === 'done')
        return (
          ((f as { kind?: unknown }).kind === 'file' || (f as { kind?: unknown }).kind === 'dir') &&
          str((f as { name?: unknown }).name)
        );
      if (f.op === 'error') return str((f as { reason?: unknown }).reason);
      return false;
    }
    case 'search': {
      const q = m as { op?: unknown; id?: unknown; hits?: unknown; fallback?: unknown };
      if (!str(q.id)) return false;
      if (q.op === 'hits') return Array.isArray(q.hits) && typeof q.fallback === 'boolean';
      if (q.op === 'error') return str((q as { reason?: unknown }).reason);
      return false;
    }
    default:
      return false;
  }
}

export class HostLink {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff: number;
  private timer: NodeJS.Timeout | null = null;
  /** paneId → the loopback socket standing in for that remote runner. */
  private readonly relays = new Map<string, WebSocket>();
  /**
   * Frames that arrived before that socket finished connecting.
   *
   * THE FIRST FRAME IS THE ONE THAT MATTERS. A runner sends `hello` the
   * instant it connects, and the loopback this relays through takes a moment
   * to open — so without a queue the hello is always the frame that gets
   * dropped. The server then never records the session id, and the chat view,
   * which keys its "Starting…" spinner on `current_sid`, spins forever over a
   * runner that is in fact attached and answering.
   *
   * The same buffering exists in the host agent's ptyd proxy for the same
   * reason; I wrote it there and did not write it here.
   */
  private readonly pending = new Map<string, string[]>();
  /**
   * The panes this server is watching on this host, and with what tail.
   *
   * REPLAYED ON EVERY (RE)CONNECT, which is the half that was missing. The
   * host closes all of its tails when the link drops — correctly: their pushes
   * would go nowhere — and the comment there says the server "re-subscribes
   * for whatever is still being viewed". Nothing did. A remote chat therefore
   * survived a link blip looking recovered (the runner re-registers, the
   * status comes back) and never rendered another message, because the only
   * thing that would have re-subscribed was the FIRST watcher arriving and the
   * watcher had never left.
   */
  private readonly subscribed = new Map<string, number | undefined>();
  /** In-flight searches, by correlation id. See {@link search}. */
  private readonly searches = new Map<
    string,
    (r: { hits: unknown[]; fallback: boolean } | { error: string }) => void
  >();
  /** In-flight `files` pulls, by correlation id. See {@link fetchPath}. */
  private readonly fetches = new Map<
    string,
    { recv: FileReceiver; settle: (r: { path: string } | { error: string }) => void }
  >();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: HostLinkDeps) {
    this.log = deps.log ?? ((l) => console.log(l));
    this.backoff = deps.initialBackoffMs ?? 500;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const url = `${this.deps.endpoint.replace(/\/$/, '')}/link`;
    const ws = new WebSocket(url, { headers: { 'x-muxpad-node-token': this.deps.token } });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = this.deps.initialBackoffMs ?? 500;
      this.log(`[hostlink] ${this.deps.nodeId}: link up`);
      // Whatever is still being looked at. The host's `subscribe` tears down
      // any existing tail and starts a fresh one, so this re-sends the
      // history phase as well as resuming the live stream — which is exactly
      // what a reader who has been staring at a frozen chat needs.
      for (const [paneId, tailBytes] of this.subscribed) {
        this.send({
          ch: 'transcript',
          op: 'subscribe',
          paneId,
          ...(tailBytes === undefined ? {} : { tailBytes }),
        });
      }
    });
    ws.on('message', (d) => this.onUp(d.toString()));
    ws.on('close', () => this.onGone());
    ws.on('error', (e) => {
      // Reconnect handles it; a per-attempt line on a sleeping machine would
      // fill the log with something the Machines view already shows.
      if (this.backoff <= (this.deps.initialBackoffMs ?? 500))
        this.log(`[hostlink] ${this.deps.nodeId}: ${(e as Error).message}`);
    });
  }

  private onGone(): void {
    this.ws = null;
    // Every relayed runner belonged to a link that is gone. Close them so the
    // server runs its normal runner-disconnect path — which emits a synthetic
    // turn-done for a turn that was in flight. Without this a remote chat
    // would sit `turnActive` forever: the runner is unreachable and nothing
    // else would ever close the turn out.
    for (const [, r] of this.relays) {
      try {
        r.close();
      } catch {}
    }
    this.relays.clear();
    // A transfer in flight belonged to a socket that is gone; nothing will
    // ever finish it, and its staging tree would sit in the data dir forever.
    for (const [, f] of this.fetches) {
      f.recv.dispose();
      f.settle({ error: 'the link to that machine dropped mid-transfer' });
    }
    this.fetches.clear();
    for (const [, settle] of this.searches) settle({ error: 'the link dropped' });
    this.searches.clear();
    if (this.closed) return;
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.timer.unref?.();
    this.backoff = Math.min(this.backoff * 2, this.deps.maxBackoffMs ?? 15_000);
  }

  private send(m: LinkDown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeLink(m));
  }

  private onUp(raw: string): void {
    const m = decodeLink(raw);
    if (!m) return;
    // ── THE ENVELOPE IS CHECKED; THE PAYLOAD WAS NOT ──────────────────────
    //
    // `decodeLink` validates the CHANNEL and then casts, which is honest about
    // what it does and not enough on this side: every branch below reads
    // fields off a message from a machine that may be compromised. A host that
    // answers a file fetch with `{ch:'files',op:'chunk',id:'…',rel:null}`
    // reached `rel.includes('\0')` — a TypeError inside a WebSocket message
    // handler, which is an uncaught exception and takes the whole server with
    // it. One malformed frame, install-wide outage.
    //
    // So the shapes are checked here rather than deeper: this is the boundary,
    // and a frame that fails is dropped exactly as a malformed one is. The
    // protocol's own note promises that a parse failure "closes a message,
    // never the process" — this is what makes that true of the payload too.
    if (!wellFormed(m)) {
      this.log(`[hostlink] ${this.deps.nodeId}: dropped a malformed ${m.ch} frame`);
      return;
    }
    if (m.ch === 'transcript') {
      if (m.op === 'events')
        this.deps.onTranscript({
          paneId: m.paneId,
          kind: 'events',
          phase: m.phase,
          events: m.events,
        });
      else if (m.op === 'title')
        this.deps.onTranscript({ paneId: m.paneId, kind: 'title', title: m.title });
      else if (m.op === 'unavailable')
        this.deps.onTranscript({ paneId: m.paneId, kind: 'unavailable', reason: m.reason });
      return;
    }
    if (m.ch === 'api') {
      if (m.op === 'request') void this.answerApi(m.id, m.method, m.path, m.body);
      return;
    }
    if (m.ch === 'search') {
      if (m.op === 'query') return; // our own frame coming back; not an answer
      const settle = this.searches.get(m.id);
      if (!settle) return; // already timed out
      this.searches.delete(m.id);
      settle(m.op === 'hits' ? { hits: m.hits, fallback: m.fallback } : { error: m.reason });
      return;
    }
    if (m.ch === 'files') {
      const f = this.fetches.get(m.id);
      if (!f) return; // already settled (timed out, or the link bounced)
      if (m.op === 'chunk') {
        f.recv.chunk(m.rel, m.b64, m.last);
        // A refusal mid-transfer (a path escaping the staging dir, too many
        // bytes) ends it now rather than at `done` — there is no reason to
        // keep writing a tree we have already decided not to use.
        const bad = f.recv.error;
        if (bad) {
          this.fetches.delete(m.id);
          f.recv.dispose();
          f.settle({ error: bad });
        }
        return;
      }
      // `fetch` is the one `files` op this side SENDS; seeing it come back up
      // is a host replaying our own frame, not an answer to it.
      if (m.op === 'fetch') return;
      this.fetches.delete(m.id);
      if (m.op === 'error') {
        f.recv.dispose();
        f.settle({ error: m.reason });
        return;
      }
      const path = f.recv.finish(m.kind, m.name);
      if (!path) {
        const why = f.recv.error ?? 'the transfer could not be staged';
        f.recv.dispose();
        f.settle({ error: why });
        return;
      }
      // The CALLER disposes on success — it is holding the only reference to
      // the staged path and is the only thing that knows when publish is done
      // reading it.
      f.settle({ path });
      return;
    }
    if (m.ch !== 'runner') return;
    if (m.op === 'attached') {
      this.openRelay(m.paneId);
      return;
    }
    if (m.op === 'detached') {
      this.relays.get(m.paneId)?.close();
      this.relays.delete(m.paneId);
      this.pending.delete(m.paneId);
      return;
    }
    if (m.op === 'frame') {
      const r = this.relays.get(m.paneId);
      const payload = JSON.stringify(m.frame);
      if (r?.readyState === WebSocket.OPEN) {
        r.send(payload);
        return;
      }
      // Still connecting (or announced a frame before `attached`): hold it.
      // Capped, because a relay that never opens must not grow without bound
      // — and a runner that has sent hundreds of frames before its socket
      // came up is broken in a way more buffer will not fix.
      const q = this.pending.get(m.paneId) ?? [];
      if (q.length < 64) q.push(payload);
      this.pending.set(m.paneId, q);
      if (!r) this.openRelay(m.paneId);
    }
  }

  /**
   * Search this host's archive.
   *
   * ALWAYS resolves, and an unreachable or silent host resolves to an ERROR
   * rather than to no hits — the value of a cross-host result is knowing
   * which machines actually answered, and a machine that was asleep must not
   * look like a machine with nothing in it.
   *
   * The timeout is short on purpose: somebody is waiting at a search box, and
   * one sleeping laptop must not hold the whole result set.
   */
  search(
    q: string,
    opts: { limit: number; role?: string },
    timeoutMs = 4_000,
  ): Promise<{ hits: unknown[]; fallback: boolean } | { error: string }> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ error: 'not connected' });
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.searches.delete(id)) return;
        resolve({ error: 'did not answer in time' });
      }, timeoutMs);
      timer.unref?.();
      this.searches.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send({
        ch: 'search',
        op: 'query',
        id,
        q,
        limit: opts.limit,
        ...(opts.role ? { role: opts.role } : {}),
      });
    });
  }

  /**
   * Pull a path from this host into a staging directory here.
   *
   * For `muxpad publish` in a remote chat: the artifact's bytes are on that
   * machine and the public server streams from this one's disk. The server
   * ASKS for exactly the path the publish named — a host cannot start a
   * transfer (see link-protocol's `hostMaySend`), so this cannot become a way
   * to deposit files on this machine.
   *
   * On success the caller owns `dispose` — it is the only thing that knows
   * when publish has finished reading the staged tree. On failure the staging
   * directory is already gone.
   */
  fetchPath(
    path: string,
    stagingRoot: string,
    timeoutMs = 120_000,
  ): Promise<{ path: string; dispose: () => void } | { error: string }> {
    if (this.ws?.readyState !== WebSocket.OPEN)
      return Promise.resolve({ error: 'that machine is not connected' });
    const id = randomUUID();
    const recv = new FileReceiver(stagingRoot);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.fetches.delete(id)) return;
        recv.dispose();
        resolve({ error: 'that machine did not finish sending in time' });
      }, timeoutMs);
      timer.unref?.();
      this.fetches.set(id, {
        recv,
        settle: (r) => {
          clearTimeout(timer);
          resolve('path' in r ? { path: r.path, dispose: () => recv.dispose() } : r);
        },
      });
      this.send({ ch: 'files', op: 'fetch', id, path });
    });
  }

  /**
   * Answer one `api` request, and ALWAYS answer it.
   *
   * The host's CLI is a shell script blocking on curl. A request this side
   * drops is a `muxpad card` that hangs until the agent's own timeout, which
   * reads to the user as the chat freezing — so a missing handler and a thrown
   * error both become a refusal, not silence.
   */
  private async answerApi(id: string, method: string, path: string, body?: string): Promise<void> {
    const refuse = { status: 404, body: JSON.stringify({ error: 'not found' }) };
    let out = refuse;
    try {
      out =
        (await this.deps.onApiRequest?.({
          method,
          path,
          ...(body === undefined ? {} : { body }),
        })) ?? refuse;
    } catch (e) {
      this.log(`[hostlink] ${this.deps.nodeId}: api ${method} ${path}: ${(e as Error).message}`);
      out = { status: 500, body: JSON.stringify({ error: 'internal error' }) };
    }
    this.send({ ch: 'api', op: 'response', id, ...out });
  }

  /**
   * Stand a remote runner up as a local connection to our own endpoint.
   *
   * `x-muxpad-node-id` is set HERE, by this server, on a socket it opened —
   * which is what makes the pane-ownership check real. A host cannot forge it:
   * it never touches this request.
   */
  private openRelay(paneId: string): void {
    this.relays.get(paneId)?.close();
    const url = `${this.deps.selfUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws/agent-runner/${paneId}`;
    const ws = new WebSocket(url, {
      headers: {
        'x-muxpad-node-id': this.deps.nodeId,
        ...(() => {
          const k = this.deps.apiKey();
          return k ? { 'x-muxpad-key': k } : {};
        })(),
        // Our own origin, so the CSRF guard on the upgrade sees a same-origin
        // request rather than `null` and refuses it.
        origin: this.deps.selfUrl,
      },
    });
    this.relays.set(paneId, ws);
    // DRAIN THE QUEUE, OR BUFFERING THE HELLO ACHIEVES NOTHING. Holding the
    // frame was only half the fix: without this the hello is queued instead of
    // dropped, which looks identical from the chat view — a runner attached and
    // answering, over a spinner that never clears.
    ws.on('open', () => {
      const q = this.pending.get(paneId);
      this.pending.delete(paneId);
      if (!q?.length || this.relays.get(paneId) !== ws) return;
      for (const payload of q) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(payload);
      }
    });
    ws.on('message', (d) => {
      // Our own server's frames, but a throw here is an uncaught exception on
      // an event handler — one malformed send would take the process down.
      let frame: unknown;
      try {
        frame = JSON.parse(d.toString());
      } catch {
        return;
      }
      this.send({ ch: 'runner', op: 'frame', paneId, frame });
    });
    ws.on('close', () => {
      if (this.relays.get(paneId) === ws) this.relays.delete(paneId);
    });
    ws.on('error', (e) =>
      this.log(`[hostlink] ${this.deps.nodeId}: relay for ${paneId}: ${(e as Error).message}`),
    );
  }

  /**
   * Begin receiving a remote chat's history.
   *
   * Recorded as well as sent, so a reconnect can replay it — see
   * {@link subscribed}. Safe to call for a pane already subscribed: the host
   * restarts its tail and re-sends the history phase, and a chat client
   * dedupes events by id, so a second reader joining costs the first one
   * nothing.
   */
  subscribeTranscript(paneId: string, tailBytes?: number): void {
    this.subscribed.set(paneId, tailBytes);
    this.send({
      ch: 'transcript',
      op: 'subscribe',
      paneId,
      ...(tailBytes === undefined ? {} : { tailBytes }),
    });
  }

  unsubscribeTranscript(paneId: string): void {
    this.subscribed.delete(paneId);
    this.send({ ch: 'transcript', op: 'unsubscribe', paneId });
  }

  loadOlderTranscript(paneId: string): void {
    this.send({ ch: 'transcript', op: 'loadOlder', paneId });
  }

  get up(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** What this link was DIALLED at, and with. `HostLinks.sync` compares both:
   *  a re-pointed endpoint or a re-minted token needs a new dial, because a
   *  link carries its credential from the dial and nothing re-presents it. */
  get dialledAt(): { endpoint: string; token: string } {
    return { endpoint: this.deps.endpoint, token: this.deps.token };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const [, r] of this.relays) {
      try {
        r.close();
      } catch {}
    }
    this.relays.clear();
    this.ws?.close();
  }
}
