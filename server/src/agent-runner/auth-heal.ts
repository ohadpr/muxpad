// SELF-HEAL FOR A DEAD CREDENTIAL — the classifier and the give-up policy.
//
// THE FAILURE THIS EXISTS FOR (live incident, 2026-09-20). muxpad runs one
// persistent `query()` session per pane, which is one long-lived `claude` child
// per pane. The CLI reads its OAuth credential ONCE at process start and has no
// way to re-read it. So when the access token expires, every child races the
// same refresh: the first to win rotates the refresh token and the rest are
// left holding one that is now invalid. Twenty-five panes then fail every turn
// in ~0.05 s.
//
// The part that makes it a muxpad bug rather than an auth bug is what happens
// next: a human runs `/login`, a fresh credential lands on disk — and no
// running child ever reads it. The panes stay dead indefinitely. Proven on the
// box: the exact bundled binary muxpad uses authenticated immediately after
// `/login` while the already-running pane children kept failing. Fresh process
// fine, old process broken.
//
// So the recovery is not "retry the turn" — retrying inside the same child can
// never work. It is "throw the child away and spawn another", which is what a
// re-exec of the SDK session does. The turn is retried AFTER that.
//
// WHY THE CLASSIFIER IS ON ASSISTANT TEXT AND NOT ON THE RESULT. Transcribed
// from the pane log of the incident:
//
//   17:13:09.262Z ready · claude-opus-5 · 117 tools
//   17:13:09.316Z claude Not logged in · Please run /login
//   17:13:09.318Z ✓ turn done · 0.0s · $165.05
//
// The turn `result` says **success**. The CLI reports the auth failure as an
// ordinary assistant message and then closes the turn normally, so there is no
// error subtype, no `errors` array and no thrown exception to key off. The only
// signal on the wire is that one line of text.

/**
 * The exact strings, verbatim from the incident's pane logs:
 *
 *   `Failed to authenticate: OAuth session expired and could not be refreshed`
 *   `Not logged in · Please run /login`
 *
 * `Invalid API key · Please run /login` is the third member of the family. It
 * is NOT live-verified here — it is included because the asymmetry runs one
 * way: a missed variant is the original incident (every pane dead until a human
 * notices), and a false positive costs one session re-exec, bounded by the
 * ladder below. If the key really is invalid rather than stale, the re-execs
 * exhaust and give up loudly, which is the correct end state either way.
 */
const AUTH_FAILURE_OPENINGS: readonly RegExp[] = [
  /^not logged in\b/,
  /^failed to authenticate\b/,
  /^invalid api key\b/,
];

/**
 * An opening that is unambiguous on its own: it names the MECHANISM, which is
 * not a thing a passing note says.
 */
const AUTH_FAILURE_COMPLETE: readonly RegExp[] = [/^oauth (session|token) (expired|revoked)\b/];

/**
 * …and what the rest of the message has to look like for an opening to count.
 *
 * The original rule was "one line, short, starts with a known phrase", on the
 * reasoning that prose mentioning these "is multi-line, or long, or says
 * something before it". That is true of prose and false of a SCRATCHPAD, which
 * is what plain assistant text IS in Chat mode: short single-line notes, with
 * nothing in front of them, written by agents who — in this repository — debug
 * auth for a living. `Not logged in — that's the bug.` is 31 characters and
 * satisfied all three conditions.
 *
 * So the message must also CONTINUE like an error rather than like a thought:
 * after the opening it has to name the mechanism or the fix. Every verbatim
 * variant from the incident does (`· Please run /login`, `: OAuth session
 * expired and could not be refreshed`); a note about one does not.
 */
const AUTH_FAILURE_TAIL =
  /\/login|\blog ?in\b|\boauth\b|\bcredentials?\b|\bapi key\b|\btokens?\b|\bexpired\b|\brefreshed?\b|\bauthenticat/;

/**
 * The longest an auth message is allowed to be before we stop believing it is
 * one. Every observed variant is a single short line; this is the guard that
 * keeps an AGENT WRITING ABOUT auth failures — in a codebase whose agents do
 * exactly that — from re-execing its own session.
 */
const MAX_AUTH_MESSAGE_LEN = 200;

/**
 * Is this assistant message the CLI saying its credentials are dead?
 *
 * Matched against the WHOLE message, not searched within it. Four conditions,
 * all load-bearing against the false positive: one line, short, STARTING with
 * a known phrase, and CONTINUING like an error (see AUTH_FAILURE_TAIL) rather
 * than like a note about one.
 *
 * The caller adds a fifth that text alone cannot supply — the turn made no
 * tool calls — because the failing child never reaches a model at all. See the
 * turn-result branch in backends/claude.ts.
 */
export function isAuthFailureText(text: string): boolean {
  const s = text.trim();
  if (!s || s.length > MAX_AUTH_MESSAGE_LEN || s.includes('\n')) return false;
  const lower = s.toLowerCase();
  if (AUTH_FAILURE_COMPLETE.some((re) => re.test(lower))) return true;
  for (const re of AUTH_FAILURE_OPENINGS) {
    const m = lower.match(re);
    // The tail is searched AFTER the opening: `invalid api key` would
    // otherwise satisfy its own tail requirement and prove nothing.
    if (m && AUTH_FAILURE_TAIL.test(lower.slice(m[0].length))) return true;
  }
  return false;
}

/**
 * The re-exec ladder. Same four rails as respawn-policy.ts (cooldown, attempt
 * cap, probation, visible give-up) applied to a session rather than a pane —
 * because the hazard is identical: something muxpad restarts unasked, against a
 * condition it cannot itself fix, is one bad branch away from an infinite
 * spawn loop.
 *
 * The FIRST attempt is immediate and that is the whole point of the feature: a
 * token that expired mid-conversation, with credentials already refreshed on
 * disk by another process, heals in the time it takes to spawn a child, and the
 * user sees their answer instead of an error. The later rungs are for the case
 * where nothing on disk is valid yet, where the right behaviour is to slow down
 * and eventually shut up.
 */
export const AUTH_HEAL_DELAYS_MS: readonly number[] = [0, 5_000, 20_000, 60_000];

/**
 * After giving up, how long before the ladder re-arms.
 *
 * Give-up cannot be permanent: the condition is fixed by an action taken
 * OUTSIDE this process (a human running `/login`), possibly hours later, and a
 * pane that has decided never to try again is the original incident with extra
 * steps. It also cannot be instant, or "gave up" would mean nothing. Ten
 * minutes bounds a never-logged-in machine to one four-attempt burst per ten
 * minutes, and bounds the give-up notification — one per burst — to the same.
 */
export const AUTH_HEAL_REARM_MS = 10 * 60_000;

/** What the policy says to do about an auth failure that just happened. */
export type AuthHealDecision =
  | {
      /** Re-exec the session — after `delayMs`. */
      kind: 'heal';
      delayMs: number;
      /** 1-based, for the log line. */
      attempt: number;
      of: number;
    }
  | {
      /** The ladder is exhausted. Say so where a human will see it, and stop. */
      kind: 'give-up';
      of: number;
    }
  | {
      /** Already gave up and still inside the re-arm window: stay quiet. */
      kind: 'quiet';
      /** ms until the ladder re-arms — for the log line only. */
      rearmInMs: number;
    };

/**
 * The give-up / back-off state machine for one session. Pure and clock-injected
 * so the whole ladder is unit-testable without waiting for it: the TIMER lives
 * in the backend, the DECISION lives here.
 */
export class AuthHealPolicy {
  private readonly delays: readonly number[];
  private readonly rearmMs: number;
  private readonly now: () => number;
  /** Rungs consumed since the last success (or the last re-arm). */
  private attempts = 0;
  private gaveUpAt: number | null = null;

  constructor(opts: { delaysMs?: readonly number[]; rearmMs?: number; now?: () => number } = {}) {
    // An EMPTY ladder would mean "give up immediately", which is a
    // configuration nobody wants and a test could set by accident.
    this.delays = opts.delaysMs?.length ? opts.delaysMs : AUTH_HEAL_DELAYS_MS;
    this.rearmMs = opts.rearmMs ?? AUTH_HEAL_REARM_MS;
    this.now = opts.now ?? Date.now;
  }

  /** How many rungs the ladder has (for log lines). */
  get ladder(): number {
    return this.delays.length;
  }

  /** True once the ladder is spent and before it re-arms. */
  get gaveUp(): boolean {
    return this.gaveUpAt !== null;
  }

  /** An auth failure just happened. What now? */
  decide(): AuthHealDecision {
    const now = this.now();
    if (this.gaveUpAt !== null) {
      const since = now - this.gaveUpAt;
      if (since < this.rearmMs) return { kind: 'quiet', rearmInMs: this.rearmMs - since };
      // Re-armed: a `/login` may well have happened in the meantime.
      this.gaveUpAt = null;
      this.attempts = 0;
    }
    if (this.attempts >= this.delays.length) {
      this.gaveUpAt = now;
      return { kind: 'give-up', of: this.delays.length };
    }
    const delayMs = this.delays[this.attempts] as number;
    this.attempts += 1;
    return { kind: 'heal', delayMs, attempt: this.attempts, of: this.delays.length };
  }

  /**
   * A turn completed WITHOUT an auth failure — the credential works again.
   *
   * This is the probation rail from respawn-policy.ts: the counter is forgiven
   * by evidence that the thing actually recovered, never by the mere passage of
   * time between failures. Clearing it on anything weaker re-arms the ladder
   * every cycle and the cap never bites.
   */
  ok(): void {
    this.attempts = 0;
    this.gaveUpAt = null;
  }
}

/**
 * The lock-screen sentence for a give-up. Names the condition and the one
 * action that fixes it — a notification that said "auth error" would leave the
 * user exactly where the incident left them.
 */
export function authGiveUpNotice(paneName: string, message: string): string {
  return `${paneName}: the agent cannot authenticate (${message}). Run /login on this machine — the pane retries on its own once you have.`;
}
