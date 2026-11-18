/**
 * A FIRE THAT NEVER REACHED AN AGENT, AND THEREFORE NEVER FAILED EITHER.
 *
 * `cron_runs` records what the SUBMIT answered — `sent` or `queued` — and a
 * later commit corrects that to `done` when the turn it started ends. Both
 * assume a turn happens. When the worker never starts, nothing ever corrects
 * anything: the row reads `queued` forever, `fail_streak` stays 0, and the
 * auto-disable that exists for a broken schedule never triggers.
 *
 * Measured on this machine, found by a review rather than by anybody noticing:
 * `trayo-dev-server-daily` fired at 07:01 every morning from 12 to 18 November
 * — eight mornings, eight `queued` rows, ZERO failures recorded and zero work
 * done. Its pane was created in a workspace belonging to another machine and
 * exited immediately with "this pane belongs to another machine".
 *
 * That is the worst shape a scheduled job can take: it looks healthy from
 * every surface that reports on it.
 *
 * ─── WHY A TIMEOUT ALONE WOULD BE WRONG ────────────────────────────────────
 *
 * "Still queued after N minutes" is not failure. A legitimate agent turn can
 * run for half an hour, and its row stays `queued` for all of it — marking
 * that failed would retire working schedules. So the evidence has to be that
 * the WORKER IS GONE: its pane no longer exists, or its runner is dead. A pane
 * that exists and might still be thinking is left alone however long it takes.
 */

export interface StaleFireInput {
  /** The run's recorded outcome. */
  outcome: string;
  /** When it fired. */
  firedAt: number;
  now: number;
  /** The pane the fire created, when it recorded one. */
  paneId: string | null;
  /** Does that pane still exist? */
  paneExists: boolean;
  /** Has its runner given up (automatic restarts exhausted)? */
  paneDead: boolean;
}

/**
 * How long to wait before concluding a worker is not coming.
 *
 * Generous on purpose: a cold pane spawns a shell, a runner and a model
 * session, and a slow morning can take minutes. The cost of being early is
 * retiring a schedule that works, which is strictly worse than noticing a
 * broken one an hour later.
 */
export const STALE_FIRE_MS = 10 * 60_000;

/** Did this fire die without ever producing a turn? */
export function fireDiedUnstarted(input: StaleFireInput): { dead: boolean; why: string } {
  // Only a fire still in flight can be judged; `done`, `failed`, `kept`,
  // `closed`, `skipped` and `missed` have all already said what happened.
  if (input.outcome !== 'sent' && input.outcome !== 'queued') return { dead: false, why: '' };
  if (!input.paneId) return { dead: false, why: '' };
  if (input.now - input.firedAt < STALE_FIRE_MS) return { dead: false, why: '' };
  if (!input.paneExists) return { dead: true, why: 'its chat was gone before the work started' };
  if (input.paneDead) return { dead: true, why: 'its runner never came up' };
  return { dead: false, why: '' };
}
