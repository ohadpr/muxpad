import { statSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Return `cwd` if it's an existing directory, else the home dir.
 *
 * A pane can carry a cwd that has since vanished — most commonly a git worktree
 * torn down after its ticket shipped, but also any deleted/renamed/unmounted
 * directory. Spawning a shell in a non-existent cwd makes node-pty fail and the
 * shell exit immediately; the client reads that as "the pane exited" and
 * cascade-deletes the pane — so e.g. splitting such a pane flashes a new pane
 * that instantly vanishes. Falling back to home keeps the pane usable.
 */
export function safeCwd(cwd: string | null | undefined): string {
  if (cwd) {
    try {
      if (statSync(cwd).isDirectory()) return cwd;
    } catch {
      // ENOENT / not a dir / not accessible → fall through to home.
    }
  }
  return homedir();
}
