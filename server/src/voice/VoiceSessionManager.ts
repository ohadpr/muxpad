import type { GlobalsStore } from '../store/GlobalsStore.js';
import {
  CLOSE_TIMEOUT_MS,
  DEFAULT_VOICE,
  EXCHANGE_TIMEOUT_MS,
  MAX_SDP_CHARS,
  type SdpAnswer,
  type SdpExchange,
  type SessionCloser,
  VOICE_MODEL,
  VoiceError,
  buildVoiceInstructions,
} from './live.js';

/**
 * Every cost control voice mode has, in one object.
 *
 * WHY THIS FILE EXISTS AT ALL. muxpad has never had a cost control — the only
 * adjacent thing in the tree is a 6-minute throttle on headline writes. Voice is
 * the first feature that bills by WALL CLOCK: $0.05/min, and silence costs
 * exactly what speech costs. A session nobody closed is not a degraded feature,
 * it is a meter running in an empty room. And the server is not in the media
 * path (see voice/live.ts), so "the client will close it" is a hope, not a
 * mechanism: a phone that backgrounds mid-sentence never runs another line of
 * our JavaScript.
 *
 * So the controls here are deliberately the ones that need nobody's cooperation:
 *
 *   ONE LIVE SESSION per install. A second request is refused (409) rather than
 *   queued. Two concurrent streams is not a feature anyone asked for and it is
 *   the difference between a leak and a doubled leak.
 *
 *   A HARD TTL (default 10 min). Past it we stop counting the session as live,
 *   free the slot, and ask upstream to close. The client is told the deadline up
 *   front (`expiresAt`) so a healthy browser hangs up on its own.
 *
 *   A DAILY MINUTE CEILING (default 60 min), persisted in `globals` so a restart
 *   does not hand out a fresh hour. This is the only control that bounds the
 *   worst case rather than one instance of it.
 *
 *   CLOSE ON DISCONNECT. The pane's chat socket going quiet (after a short
 *   grace, so a reconnect isn't a hang-up) or the pane being deleted closes the
 *   session.
 *
 * ACCOUNTING IS DELIBERATELY PESSIMISTIC. Every session is charged at least
 * {@link MIN_BILLED_SECONDS}, because creating a WebRTC session bills 15 seconds
 * up front (credited only once it actually runs) — so speculative creation is
 * not free and must not read as free. An open session found in the ledger at
 * startup is settled at its FULL TTL, because a process that died mid-session
 * has no idea when, or whether, the stream stopped. Both biases spend budget the
 * user may not have spent. That is the correct direction to be wrong in when the
 * alternative is a number on their card.
 */

/** Default per-session wall-clock ceiling. Ten minutes is ~$0.50 — a bounded
 *  mistake — and longer than any hands-free exchange this is built for. */
export const DEFAULT_SESSION_TTL_MS = 10 * 60_000;

/** Default daily ceiling: 60 minutes ≈ $3/day worst case. */
export const DEFAULT_DAILY_CAP_MINUTES = 60;

/**
 * Grace between "this pane has no chat socket" and hanging up.
 *
 * Not zero: the WebRTC connection is peer-to-peer and survives a muxpad socket
 * blip, so killing the call on every dropped frame would make voice unusable on
 * a phone changing cells. Not long either — this window is the exact size of the
 * leak when someone closes the tab mid-call.
 */
export const DISCONNECT_GRACE_MS = 15_000;

/** Floor on what any session costs, per OpenAI's 15-second upfront charge. */
export const MIN_BILLED_SECONDS = 15;

/** `globals` key holding the day's usage. */
export const VOICE_USAGE_KEY = 'voice_usage';

/** Persisted usage. `open` is the session that was live when we last wrote —
 *  present only while one is running, or after a crash that left one behind. */
interface Ledger {
  day: string;
  seconds: number;
  open: { id: string; startedAt: number; ttlMs: number } | null;
}

const EMPTY_LEDGER: Ledger = { day: '', seconds: 0, open: null };

/** Local calendar day. Local, not UTC: "today" in a daily budget means the
 *  user's today, and a UTC rollover mid-evening would be surprising. */
export function dayKey(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface VoiceStatus {
  configured: boolean;
  live: boolean;
  minutesToday: number;
  capMinutes: number;
}

export interface VoiceSessionStarted {
  sessionId: string;
  sdp: string;
  expiresAt: number | null;
  voice: string;
}

export interface VoiceSessionManagerDeps {
  /** Persistence for the daily meter. */
  globals: GlobalsStore;
  /** The OpenAI round trip. Absent → the feature reports itself unconfigured
   *  and every start is a 503. This is how "no API key" is represented: there is
   *  no code path that builds a transport without one. */
  exchange?: SdpExchange | undefined;
  /** Best-effort upstream close. Optional; absent means local bookkeeping only. */
  closeRemote?: SessionCloser | undefined;
  /** The instructions to prime a session with — in production, muxpad's live
   *  glossary (see voice/live.ts and chat/glossary.ts). Called per session so a
   *  tab renamed this morning is a word the model knows this afternoon. */
  instructions: () => string;
  /** Does this pane exist? Guards the close-on-disconnect promise: a session
   *  pinned to a pane id nobody will ever disconnect has only the TTL. */
  paneExists?: ((paneId: string) => boolean) | undefined;
  voice?: string | undefined;
  sessionTtlMs?: number | undefined;
  dailyCapMinutes?: number | undefined;
  /** Test seams. */
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}

interface LiveSession {
  id: string;
  paneId: string;
  startedAt: number;
  deadline: number;
  ttlTimer: ReturnType<typeof setTimeout>;
}

export class VoiceSessionManager {
  private readonly globals: GlobalsStore;
  private readonly exchange: SdpExchange | null;
  private readonly closeRemote: SessionCloser | null;
  private readonly instructions: () => string;
  private readonly paneExists: (paneId: string) => boolean;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  readonly voice: string;
  readonly sessionTtlMs: number;
  readonly capMinutes: number;

  /** The one live session, or null. */
  private session: LiveSession | null = null;
  /**
   * Slot reserved between the busy check and the session actually existing.
   *
   * The check-then-set straddles an `await` (the SDP exchange is a network round
   * trip), so without this two POSTs landing in the same tick would both see an
   * empty slot and both start a paid session. Set synchronously; cleared on
   * every exit path.
   */
  private starting = false;
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: VoiceSessionManagerDeps) {
    this.globals = deps.globals;
    this.exchange = deps.exchange ?? null;
    this.closeRemote = deps.closeRemote ?? null;
    this.instructions = deps.instructions;
    this.paneExists = deps.paneExists ?? (() => true);
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line: string) => console.warn(line));
    this.voice = deps.voice ?? DEFAULT_VOICE;
    this.sessionTtlMs = Math.max(60_000, deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
    this.capMinutes = Math.max(0, deps.dailyCapMinutes ?? DEFAULT_DAILY_CAP_MINUTES);
    this.recoverOrphan();
  }

  get configured(): boolean {
    return this.exchange !== null;
  }

  // ── ledger ────────────────────────────────────────────────────────────

  /**
   * Read the meter, field by field, trusting nothing.
   *
   * An unparsable row reads as an empty day — i.e. it RESETS the budget. Said
   * out loud because it is the one way the ceiling can be lifted without
   * anyone's consent. It is acceptable only because this key has exactly one
   * writer (writeLedger, one `JSON.stringify` away) and no API can set it: the
   * realistic cause is a half-written row after a hard kill, where refusing
   * voice forever would be the worse failure.
   */
  private readLedger(): Ledger {
    const raw = this.globals.get(VOICE_USAGE_KEY);
    if (!raw) return { ...EMPTY_LEDGER };
    try {
      const v = JSON.parse(raw) as Partial<Ledger>;
      return {
        day: typeof v.day === 'string' ? v.day : '',
        seconds: typeof v.seconds === 'number' && Number.isFinite(v.seconds) ? v.seconds : 0,
        open:
          v.open && typeof v.open.id === 'string' && typeof v.open.startedAt === 'number'
            ? {
                id: v.open.id,
                startedAt: v.open.startedAt,
                ttlMs: typeof v.open.ttlMs === 'number' ? v.open.ttlMs : this.sessionTtlMs,
              }
            : null,
      };
    } catch {
      return { ...EMPTY_LEDGER };
    }
  }

  private writeLedger(l: Ledger): void {
    this.globals.set(VOICE_USAGE_KEY, JSON.stringify(l));
  }

  /** Today's settled seconds, rolled over if the ledger is from another day. */
  private settledToday(l: Ledger, today: string): number {
    return l.day === today ? l.seconds : 0;
  }

  /**
   * A session recorded as open with no live session in memory is an orphan: the
   * process it belonged to is gone. We cannot know when — or whether — the
   * stream stopped, so it is settled at its full TTL. Overcharging our own
   * budget is the safe error; undercharging hands out minutes that were already
   * spent at the vendor.
   */
  private recoverOrphan(): void {
    const l = this.readLedger();
    if (!l.open) return;
    const today = dayKey(this.now());
    const charged = Math.max(MIN_BILLED_SECONDS, l.open.ttlMs / 1000);
    this.writeLedger({
      day: today,
      seconds: this.settledToday(l, today) + charged,
      open: null,
    });
    this.log(
      `muxpad voice: a session was still open when the server stopped; charged its full ${Math.round(l.open.ttlMs / 60_000)}-minute limit against today's budget (we cannot know when it really ended).`,
    );
  }

  /** Minutes spent today, including the one running right now. */
  minutesToday(): number {
    const today = dayKey(this.now());
    const l = this.readLedger();
    let seconds = this.settledToday(l, today);
    if (l.open && l.day === today) {
      seconds += Math.max(MIN_BILLED_SECONDS, (this.now() - l.open.startedAt) / 1000);
    }
    return Math.round((seconds / 60) * 100) / 100;
  }

  status(): VoiceStatus {
    return {
      configured: this.configured,
      live: this.session !== null,
      minutesToday: this.minutesToday(),
      capMinutes: this.capMinutes,
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start the one session, or refuse.
   *
   * Order matters and is the security property: configured → shape → busy →
   * budget, all BEFORE the network call, because the network call is what costs
   * money. muxpad has no auth (reachability is authorization), so anyone who can
   * reach this port can spend the user's money here; these four gates are the
   * entire mitigation and none of them may be delegated to the client.
   */
  async start(req: { paneId: unknown; sdp: unknown }): Promise<VoiceSessionStarted> {
    if (!this.exchange) {
      throw new VoiceError(
        'voice_unconfigured',
        'voice is off: set MUXPAD_OPENAI_API_KEY (or OPENAI_API_KEY) and restart muxpad',
      );
    }
    const paneId = typeof req.paneId === 'string' ? req.paneId.trim() : '';
    const sdp = typeof req.sdp === 'string' ? req.sdp : '';
    if (!paneId) throw new VoiceError('bad_request', 'paneId is required');
    if (!sdp.trim()) throw new VoiceError('bad_request', 'sdp is required');
    if (sdp.length > MAX_SDP_CHARS) {
      throw new VoiceError('bad_request', `sdp exceeds ${MAX_SDP_CHARS} characters`);
    }
    if (!this.paneExists(paneId)) throw new VoiceError('bad_request', 'unknown paneId');

    if (this.session || this.starting) {
      throw new VoiceError(
        'voice_busy',
        'a voice session is already live — close it before starting another',
      );
    }

    const startedAt = this.now();
    const today = dayKey(startedAt);
    const used = this.minutesToday();
    const remainingMinutes = this.capMinutes - used;
    // A sliver of budget buys a session that is charged 15 seconds and closes
    // immediately — a worse experience than an honest refusal, and it still
    // costs money. MIN_BILLED_SECONDS is the natural floor for "worth starting".
    if (remainingMinutes * 60 <= MIN_BILLED_SECONDS) {
      throw new VoiceError(
        'voice_budget',
        `today's voice budget is spent (${used.toFixed(1)} of ${this.capMinutes} minutes). It resets at midnight, or raise MUXPAD_VOICE_DAILY_MINUTES.`,
      );
    }
    // The TTL never outruns what's left in the day, so a session cannot walk
    // through the ceiling it was admitted under.
    const ttlMs = Math.min(this.sessionTtlMs, Math.floor(remainingMinutes * 60_000));

    this.starting = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), EXCHANGE_TIMEOUT_MS);
    let answer: SdpAnswer;
    try {
      answer = await this.exchange(
        {
          sdp,
          session: {
            model: VOICE_MODEL,
            // The voice lives under audio.output, NOT at session root. A root
            // `voice` is rejected outright: `Unknown parameter: 'session.voice'`
            // (HTTP 400, observed against the live API on the first real call —
            // every test passed with it at the root, because the upstream was
            // a fake that never validated the shape).
            audio: { output: { voice: this.voice } },
            instructions: this.instructions(),
            delegation: { type: 'client' },
          },
        },
        abort.signal,
      );
    } catch (err) {
      this.starting = false;
      if (err instanceof VoiceError) throw err;
      throw new VoiceError('voice_upstream', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }

    // Reserve in the ledger BEFORE the slot is live: if we die in the next
    // millisecond, the orphan recovery above charges this session rather than
    // losing it.
    const l = this.readLedger();
    this.writeLedger({
      day: today,
      seconds: this.settledToday(l, today),
      open: { id: answer.sessionId, startedAt, ttlMs },
    });

    const deadline = startedAt + ttlMs;
    const ttlTimer = setTimeout(() => this.expire(answer.sessionId), ttlMs);
    ttlTimer.unref?.();
    this.session = { id: answer.sessionId, paneId, startedAt, deadline, ttlTimer };
    this.starting = false;
    this.cancelDisconnect(paneId);

    return {
      sessionId: answer.sessionId,
      sdp: answer.sdp,
      // Ours, not upstream's: OpenAI states no expiry, and the deadline the
      // client actually has to respect is the TTL we will enforce. Upstream wins
      // only if it ever starts sending one that is sooner.
      expiresAt:
        answer.expiresAt !== null && answer.expiresAt < deadline ? answer.expiresAt : deadline,
      voice: this.voice,
    };
  }

  /**
   * Close the live session. Idempotent and total: an unknown or already-closed
   * id is a no-op, because DELETE is the client's panic button and a 404 there
   * would only teach it to stop trying.
   */
  stop(sessionId: string, reason: string): boolean {
    const s = this.session;
    if (!s || s.id !== sessionId) return false;
    this.settle(s, reason);
    return true;
  }

  /** TTL fired. Same path as an explicit close, different reason. */
  private expire(sessionId: string): void {
    const s = this.session;
    if (!s || s.id !== sessionId) return;
    this.log(
      `muxpad voice: closed session after its ${Math.round((s.deadline - s.startedAt) / 60_000)}-minute limit. The browser was asked to hang up; if it did not, the call may still be billing at OpenAI.`,
    );
    this.settle(s, 'ttl');
  }

  /**
   * Free the slot, charge the ledger, ask upstream to close.
   *
   * The order is not arbitrary: local state first, so a slow or failing remote
   * close can never leave muxpad believing a session is live (which would 409
   * every subsequent attempt and make the feature look broken).
   */
  private settle(s: LiveSession, reason: string): void {
    clearTimeout(s.ttlTimer);
    this.session = null;
    this.cancelDisconnect(s.paneId);

    const endedAt = Math.min(this.now(), s.deadline);
    const charged = Math.max(MIN_BILLED_SECONDS, (endedAt - s.startedAt) / 1000);
    const today = dayKey(endedAt);
    const l = this.readLedger();
    const spent = this.settledToday(l, today) + charged;
    this.writeLedger({ day: today, seconds: spent, open: null });
    // One line per closed session, naming what ended it and what it cost. muxpad
    // has never billed by the minute before, so "where did the hour go?" needs an
    // answer that isn't a vendor dashboard. No ids from upstream, no secrets.
    this.log(
      `muxpad voice: session closed (${reason}) after ${Math.round(charged)}s — ${(spent / 60).toFixed(1)} of ${this.capMinutes} minutes used today.`,
    );

    if (this.closeRemote) {
      const abort = new AbortController();
      const t = setTimeout(() => abort.abort(), CLOSE_TIMEOUT_MS);
      t.unref?.();
      void this.closeRemote(s.id, abort.signal)
        .catch(() => {
          // Best effort by construction — see voice/live.ts.
        })
        .finally(() => clearTimeout(t));
    }
  }

  // ── close on disconnect ───────────────────────────────────────────────

  /**
   * The pane's chat sockets came or went.
   *
   * Zero sockets arms a short grace timer rather than hanging up immediately: a
   * phone switching networks drops our WebSocket while the peer-to-peer audio is
   * still perfectly fine, and a call that dies every time the train goes into a
   * tunnel is not a feature. A socket returning inside the window cancels it.
   */
  noteChatPresence(paneId: string, clients: number): void {
    if (clients > 0) {
      this.cancelDisconnect(paneId);
      return;
    }
    if (!this.session || this.session.paneId !== paneId) return;
    if (this.disconnectTimers.has(paneId)) return;
    const t = setTimeout(() => {
      this.disconnectTimers.delete(paneId);
      const s = this.session;
      if (s && s.paneId === paneId) {
        this.log(
          `muxpad voice: closed the session for pane ${paneId} — its chat view has been gone for ${Math.round(DISCONNECT_GRACE_MS / 1000)}s.`,
        );
        this.settle(s, 'disconnect');
      }
    }, DISCONNECT_GRACE_MS);
    t.unref?.();
    this.disconnectTimers.set(paneId, t);
  }

  /** The pane is gone. No grace — there is nothing to come back to. */
  notePaneRemoved(paneId: string): void {
    this.cancelDisconnect(paneId);
    const s = this.session;
    if (s && s.paneId === paneId) this.settle(s, 'pane-removed');
  }

  private cancelDisconnect(paneId: string): void {
    const t = this.disconnectTimers.get(paneId);
    if (t) {
      clearTimeout(t);
      this.disconnectTimers.delete(paneId);
    }
  }

  /**
   * Process is going down. Settle the live session so the minutes are on the
   * books and the orphan path has nothing to over-charge on next boot.
   */
  dispose(): void {
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
    if (this.session) this.settle(this.session, 'shutdown');
  }
}

/** The instructions thunk production uses: muxpad's live glossary, rebuilt
 *  behind the same cache the dictation cleanup endpoint uses. */
export function glossaryInstructions(glossary: () => readonly string[]): () => string {
  return () => buildVoiceInstructions(glossary());
}
