/**
 * Should this browser be stopped for being idle?
 *
 * Pulled out of the sweep so the decision is testable without a Chrome, a
 * timer, or an app registry — the sweep around it is plumbing, this is the part
 * that can be wrong.
 *
 * THE BUG IT EXISTS FOR. muxpad reaped session browsers on one condition — "is
 * your tab gone?" — which is right for a dead session and silent about memory.
 * A browser whose tab is still open was immortal however long nobody touched
 * it. Measured: two idle headless Chromes holding one blank `chrome://newtab/`
 * between them, 1.1 GB each after four hours; and in the report that prompted
 * this, 22.37 GB EACH, with macOS refusing to allocate any more.
 *
 * EVERY "DON'T KNOW" MEANS DON'T STOP. A browser is cheap to restart and
 * expensive to pull out from under somebody — the asymmetry runs one way, so
 * every uncertain branch here returns false.
 */
export interface IdleReport {
  /** CDP sockets the agent holds open. */
  agents: number;
  /** Screencast viewers attached. */
  viewers: number;
  /** Milliseconds since the last one let go. 0 while any remain. */
  idleMs: number;
}

export interface IdleStopInput {
  /** The host's own answer, or null when it could not be reached or parsed. */
  report: IdleReport | null;
  /** Is the app actually running right now? */
  running: boolean;
  /** False while a HUMAN holds the wheel — see BrowserWheel. */
  agentMayDrive: boolean;
  idleThresholdMs: number;
}

export function shouldStopIdleBrowser(i: IdleStopInput): boolean {
  // Not running: nothing to stop.
  if (!i.running) return false;
  // Unreachable, too old to know the route, or garbage back. A failed read is
  // not evidence of idleness.
  if (!i.report) return false;
  // Somebody is holding it. `idleMs` is already 0 in this case, but the counts
  // are checked directly so a host that reports them inconsistently still
  // fails safe.
  if (i.report.agents > 0 || i.report.viewers > 0) return false;
  // A human mid-login holds the wheel with no socket of their own between taps
  // — the one case where "nobody is attached" is true and stopping is worst.
  if (!i.agentMayDrive) return false;
  return i.report.idleMs >= i.idleThresholdMs;
}
