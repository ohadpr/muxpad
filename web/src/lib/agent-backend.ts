// Agent backends a pane can run. Mirrors the server's BackendId allowlist.
export type AgentBackendId = 'claude' | 'codex' | 'cursor';

/** The picker's agent choices, in display order. */
export const AGENT_BACKENDS: ReadonlyArray<{ id: AgentBackendId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

/** Startup command for a NEW agent pane: no harness chosen yet. The pane idles
 *  and the chat face shows the harness picker; picking one rewrites this to the
 *  real backend + respawns (POST /panes/:id/agent-backend). */
export const PENDING_AGENT_STARTUP = 'muxpad agent --pick';
