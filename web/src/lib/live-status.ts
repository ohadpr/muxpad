/**
 * Collapsed label for the agents cell of the composer status bar.
 * Returns null when no subagents are running — parent-turn busy state
 * lives in the transcript Working… row, not here.
 */
export function liveStatusLabel(opts: { agentCount: number }): string | null {
  const { agentCount } = opts;
  if (agentCount <= 0) return null;
  return `${agentCount} agent${agentCount === 1 ? '' : 's'}`;
}
