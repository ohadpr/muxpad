import type { WorkspaceAgentContext } from '../agent-instructions.js';

/**
 * THIS PANE'S WORKSPACE, as far as the instructions are concerned.
 *
 * Fetched once per runner process and cached: the instructions are injected at
 * session construction, and a workspace whose settings change mid-session is
 * handled the way a mode change is — on the next respawn, because no harness
 * can rewrite a live system prompt.
 *
 * ── WHY READING `MUXPAD_WORKSPACE_ID` IS FINE HERE, AND NOT IN THE CLI ──────
 * The CLI resolves the workspace server-side from the pane id precisely
 * because an agent could set that variable. Here it cannot matter: the worst a
 * forged value achieves is that the agent reads a different workspace's
 * INSTRUCTIONS. It grants nothing — `muxpad slack` still asks the server which
 * workspace this pane is really in, and refuses on that answer. Text is not a
 * capability.
 *
 * Fails SILENT and CLOSED: any error returns `{ slack: false }`, so a runner
 * that cannot reach the server describes no capability rather than guessing.
 */
/**
 * Resolved once at runner startup, then read synchronously.
 *
 * The backends build their system prompt in synchronous code, and threading
 * `await` through three of them to fetch one row would make every call site
 * async for a value that cannot change within a session anyway. So it is
 * PRIMED at boot and read as a plain value after.
 *
 * The default before priming is `{ slack: false }` — a capability gate whose
 * answer has not arrived yet must say no.
 */
let resolved: WorkspaceAgentContext = { slack: false };
let cached: Promise<WorkspaceAgentContext> | null = null;

/** Read the primed value. Safe before priming; says no. */
export function workspaceAgentContextSync(): WorkspaceAgentContext {
  return resolved;
}

export function workspaceAgentContext(): Promise<WorkspaceAgentContext> {
  if (cached) return cached;
  cached = (async (): Promise<WorkspaceAgentContext> => {
    const api = process.env.MUXPAD_API_URL;
    const ws = process.env.MUXPAD_WORKSPACE_ID;
    if (!api || !ws) return { slack: false };
    try {
      const r = await fetch(`${api}/api/workspaces/${encodeURIComponent(ws)}`);
      if (!r.ok) return { slack: false };
      const w = (await r.json()) as { instructions?: string | null; slack?: boolean };
      resolved = { instructions: w.instructions ?? null, slack: !!w.slack };
      return resolved;
    } catch {
      return { slack: false };
    }
  })();
  return cached;
}

/** Test seam. */
export function __resetWorkspaceAgentContext(): void {
  cached = null;
  resolved = { slack: false };
}
