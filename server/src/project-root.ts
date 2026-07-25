import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Files that mean "an agent has project context here" — git, agent rules, and
// per-project MCP config. An agent started in a folder with none of these is
// effectively lobotomized (no rules, no MCP, no repo), so we snap to the
// nearest ancestor that has them and warn when there are none.
const PROJECT_MARKERS = ['.git', 'AGENTS.md', 'CLAUDE.md', '.mcp.json'];

/** Walk up from `cwd` to the nearest ancestor containing a `.git` (dir OR file,
 *  so git worktrees count). Returns null if none up to the filesystem root. */
export function gitRoot(cwd: string): string | null {
  let dir = cwd;
  // Cap the walk so a pathological path can't loop forever.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/** True if `cwd` (or any ancestor) carries a project marker. */
export function hasProjectContext(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** The cwd a NEW AGENT pane should start in: snap up to the git worktree root
 *  (where AGENTS.md/.mcp.json live) so the agent gets its project context, not
 *  a random subdir. Falls back to the folder as-is when there's no repo. */
export function agentCwd(cwd: string): string {
  return gitRoot(cwd) ?? cwd;
}
