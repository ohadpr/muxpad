import type { AppState } from '@muxpad/shared';

/**
 * Should this app be restarted for being unreachable — and may we, again?
 *
 * Pulled out of the sweep for the reason `IdleStop` was: the timer and the
 * registry around it are plumbing, and this is the part that can be wrong.
 *
 * ─── THE GAP IT FILLS ───────────────────────────────────────────────────────
 * `reconcile` heals exactly one failure: the pane ROW is gone. An app whose
 * pane row is alive while the process behind it is dead is `unreachable`, and
 * nothing re-checks it — there is no reconcile timer at all. So it stays that
 * way for good. Measured on a live install: 8 apps unreachable at once, three
 * of them (`stakeholders`, `rows-to`, `edermedia`) for days, and a request to a
 * dead browser host hanging for 30s rather than failing.
 *
 * ─── WHY IT IS DELIBERATELY TIMID ───────────────────────────────────────────
 * A restarter that is wrong is worse than the condition it fixes: it kills a
 * server mid-request, fights the user, or spins forever. So every rule here
 * costs us a slower recovery and buys certainty, and every uncertain branch
 * returns false:
 *
 *   ONLY `unreachable`.  `stopped` is the user's own decision and outranks any
 *                        observation. `gave_up` is the supervisor's terminal
 *                        state — it stopped trying on purpose, and restarting
 *                        behind its back re-creates the loop it escaped.
 *                        `starting` is a server still waking up.
 *   STRIKES, NOT A BLIP. One failed probe is a hiccup — a GC pause, a busy
 *                        box, a proxy reloading. Only a condition that holds
 *                        across several consecutive sweeps is a condition.
 *   BOUNDED ATTEMPTS.    An app that is unreachable because its command is
 *                        broken will be unreachable after a restart too.
 *                        Restarting it every minute until the heat death of the
 *                        universe is how a heal becomes the outage.
 *
 * After the cap it is left alone and said once. A human starting it by hand
 * clears the record (see `AppHealTracker.noteState`), so the budget is per
 * SPELL of unreachability, not per app forever.
 */
export interface HealInput {
  state: AppState;
  /** Consecutive sweeps this app has looked unreachable. */
  strikes: number;
  /** Restarts already spent on THIS spell. */
  attempts: number;
  /** Strikes required before the first restart, and between later ones. */
  minStrikes: number;
  /** Most restarts one spell may cost. */
  maxAttempts: number;
}

export function shouldHealApp(i: HealInput): boolean {
  if (i.state !== 'unreachable') return false;
  if (i.attempts >= i.maxAttempts) return false;
  return i.strikes >= i.minStrikes;
}

/**
 * Sweeps an app must look unreachable for before the first restart.
 *
 * The sweep runs on `REAP_EVERY_MS` (5 minutes), so three strikes is about a
 * QUARTER OF AN HOUR down before anything is touched, and the attempts that
 * follow are spaced the same way — roughly 45 minutes to spend the whole
 * budget. That is deliberately slow: the apps this exists for had been
 * unreachable for DAYS, so fifteen minutes costs nothing, and the alternative
 * error (restarting a server that was about to answer) costs a request.
 */
export const HEAL_MIN_STRIKES = 3;
/** Restarts per spell. Three failures is an app that needs a human, not a
 *  fourth restart. */
export const HEAL_MAX_ATTEMPTS = 3;

export interface HealRecord {
  strikes: number;
  attempts: number;
  /** True once we have logged giving up, so it is said once and not per sweep. */
  announced: boolean;
}

/**
 * Per-app memory for the sweep. In memory rather than a column on purpose:
 * what it bounds is a RESTART LOOP inside one process, and a reboot is a fine
 * moment to extend fresh credit — the same reasoning `SpawnReportWriter.retried`
 * records for its own one-shot budget.
 */
export class AppHealTracker {
  private readonly rows = new Map<string, HealRecord>();

  private row(id: string): HealRecord {
    const r = this.rows.get(id) ?? { strikes: 0, attempts: 0, announced: false };
    this.rows.set(id, r);
    return r;
  }

  /**
   * Record what this app looks like now; returns its record.
   *
   * ANY state other than `unreachable` clears the spell — a running app, one the
   * user stopped, one the supervisor gave up on. That is what makes the attempt
   * budget per-spell: an app that recovers (by our hand or a human's) gets the
   * full budget again the next time it breaks, which is the behaviour you want
   * from something that is allowed to act on its own.
   */
  noteState(id: string, state: AppState): HealRecord {
    const r = this.row(id);
    if (state === 'unreachable') {
      r.strikes++;
    } else {
      r.strikes = 0;
      r.attempts = 0;
      r.announced = false;
    }
    return r;
  }

  /** A restart was just spent. Resets strikes so the NEXT attempt has to earn
   *  its own window — which is what spaces the attempts apart in time. */
  noteAttempt(id: string): void {
    const r = this.row(id);
    r.attempts++;
    r.strikes = 0;
  }

  /** True the FIRST time an app is out of attempts, so the log says it once. */
  announceGiveUp(id: string): boolean {
    const r = this.row(id);
    if (r.announced) return false;
    r.announced = true;
    return true;
  }

  /** Forget an app entirely (it was deleted). */
  forget(id: string): void {
    this.rows.delete(id);
  }

  /** Ids we are holding state for — so the sweep can drop deleted apps. */
  known(): string[] {
    return [...this.rows.keys()];
  }
}
