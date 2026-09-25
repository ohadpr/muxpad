/**
 * Collapsed label for the live cell of the composer status bar.
 *
 * ── IT REPORTS LIVENESS, NOT SUBAGENTS ──────────────────────────────────────
 * This used to take only `agentCount` and return null below one, on the stated
 * reasoning that "parent-turn busy state lives in the transcript Working… row,
 * not here". The consequence, reported: the status bar shows something running
 * ONLY when subagents happen to exist, so an ordinary turn — the common case —
 * left the bar looking idle while the sidebar row for the same pane said
 * `working`.
 *
 * Three surfaces report whether a pane is busy: the sidebar row (from the
 * server's `status`), the transcript's Working… row, and this bar. Two agreed
 * and this one was silent, which reads as a bug rather than as restraint. And
 * the transcript row is not a substitute — it scrolls away with the content,
 * while the bar is fixed and is where the session's state-at-a-glance lives
 * next to its mode, folder and model.
 *
 * So the contract is now the name: null means NOTHING is running. A turn with
 * no subagents is still a turn.
 */
export function liveStatusLabel(opts: { agentCount: number; turnActive?: boolean }): string | null {
  const { agentCount, turnActive = false } = opts;
  // Subagents win the label when they exist: "3 agents" is strictly more
  // informative than "Working…", and it is the one that opens a roster.
  if (agentCount > 0) return `${agentCount} agent${agentCount === 1 ? '' : 's'}`;
  return turnActive ? 'Working…' : null;
}
