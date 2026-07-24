// Agent backends a pane can run. Mirrors the server's BackendId allowlist.
export type AgentBackendId = 'claude' | 'codex' | 'cursor';

/** The picker's agent choices, in display order. */
export const AGENT_BACKENDS: ReadonlyArray<{ id: AgentBackendId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

/** The pane startup command for an agent backend. Claude stays implicit
 *  (`muxpad agent`) so its command is unchanged; others get `--backend <id>`. */
export function agentStartupCmd(backend: AgentBackendId = 'claude'): string {
  return backend === 'claude' ? 'muxpad agent' : `muxpad agent --backend ${backend}`;
}
