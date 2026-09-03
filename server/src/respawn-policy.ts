/**
 * Shared discipline for every pane muxpad respawns on its own initiative.
 *
 * Two supervisors use it:
 *   - the dead-runner sweep in ws.ts (agent panes, `muxpad agent%`), which
 *     detects death via "no registered runner AND no agent-runner in the pty
 *     foreground";
 *   - the serve sweep in serve-supervisor.ts (`muxpad serve%`), which detects
 *     death via "ptyd has no pty for this pane at all".
 *
 * The detection differs; the SAFETY RAILS must not. Anything muxpad restarts
 * unasked needs the same four bounds, or a pane with a broken command turns
 * into an infinite kill/spawn loop:
 *
 *   - a cooldown, because a booting process takes seconds to look alive;
 *   - an attempt cap, so a genuinely broken command converges to a visible
 *     failure instead of looping forever;
 *   - a probation window, because "it came back" only counts if it STAYS —
 *     clearing the record the instant a process appears re-arms the counter
 *     every cycle and the cap never bites (see the ws.ts comment for the real
 *     incident that taught us this);
 *   - a startup grace, so a pane created seconds ago isn't misread as dead
 *     before it has had a chance to run its startup command.
 *
 * Keeping the numbers here means a tuning change can't drift between the two
 * supervisors — and the identical rails are what let the serve sweep be
 * reviewed as "the agent sweep with a different liveness probe".
 */

/** How often each supervisor looks. */
export const RESPAWN_SWEEP_MS = 20_000;
/** Minimum gap between two respawn attempts on the SAME pane. */
export const RESPAWN_COOLDOWN_MS = 45_000;
/** Attempts before a pane is declared broken and left alone. */
export const RESPAWN_MAX_ATTEMPTS = 3;
/** How long a revived pane must stay up before its record is forgiven. */
export const RESPAWN_PROBATION_MS = 60_000;
/** A pane younger than this is still booting; never judged dead. */
export const RESPAWN_STARTUP_GRACE_MS = 30_000;
