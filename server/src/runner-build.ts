import { type Dirent, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WHICH BUILD A RUNNER IS ACTUALLY EXECUTING.
 *
 * ─── The problem this exists for ───────────────────────────────────────────
 *
 * An agent runner is a long-lived process. `muxpad restart` restarts the
 * SERVER; it deliberately leaves runners alone, because restarting one kills
 * whatever it has in flight — background subagents, wakeups, a turn. So a
 * pane keeps the build it was born with, for as long as it stays open.
 *
 * Measured on this install: 28 runners, 21 of them started before the commit
 * that began injecting muxpad's standing rules. One of them was asked to send
 * a Slack message and said it did not know how — correctly, because the rule
 * naming `muxpad slack post` had never been in its context. Its codex session
 * file is 120 MB and contains zero muxpad instruction blocks.
 *
 * Nothing on screen said so. The only symptom was an agent that did not know
 * about a feature that shipped days ago, which reads as the agent being wrong.
 *
 * ─── What "stale" MEANS, and what it must not mean ────────────────────────
 *
 * NOT "old". A runner started three weeks ago on a build nothing has changed
 * since is perfectly current, and a runner started ten minutes before a
 * deploy is not. Age is a proxy for the thing, and it is wrong in both
 * directions.
 *
 * NOT "started before this server process", either — the obvious cheap
 * signal, and it over-reports badly: a restart for an unrelated reason (a
 * crash, a config change, a machine reboot) would mark every open pane stale
 * while every one of them is running exactly the right code. A notice that
 * cries wolf after an ordinary restart is a notice people learn to ignore.
 *
 * STALE = THE RUNNER IS EXECUTING DIFFERENT CODE FROM WHAT THIS SERVER WOULD
 * START NOW. That is the fact the user cares about, it is exactly checkable,
 * and it clears itself: respawn the pane and the two ids agree again.
 *
 * ─── How the id is computed ───────────────────────────────────────────────
 *
 * The newest mtime in the server's own `dist`, as a base-36 string. A build
 * rewrites the files it changed, so any rebuild moves it; nothing else does.
 *
 * It is deliberately NOT a content hash of the entry file: `index.js` can be
 * byte-identical across a build that changed a module it imports, which is
 * the common case (the agent instructions live in another file entirely —
 * exactly the change that caused this).
 *
 * The runner captures it ONCE, at startup, and reports it in its hello. The
 * server computes the live one on demand. Equal is fresh; different is stale;
 * absent means a runner too old to report one, which is itself stale.
 */
let cached: { at: number; id: string } | null = null;

/** How long a computed id is reused. The walk is a few ms; this keeps a
 *  per-connection check from doing it on every hello in a reconnect storm. */
const CACHE_MS = 5_000;

function newestMTime(dir: string, deadline: number): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    // A pathological tree must not stall a hello. The walk is bounded in time
    // rather than in depth: `dist` is shallow, and the failure this guards
    // against is a symlink loop or a network mount, not a deep directory.
    if (Date.now() > deadline) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMTime(full, deadline));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    try {
      newest = Math.max(newest, statSync(full).mtimeMs);
    } catch {
      // A file that vanished mid-walk is a build in progress; skip it.
    }
  }
  return newest;
}

/** The id for one tree. Exported so a test can move a file and watch it
 *  change, rather than asserting the shape of a string. */
export function buildIdOf(root: string, now: number = Date.now()): string {
  return Math.round(newestMTime(root, now + 250)).toString(36);
}

/** The build this process is running, as a short stable string. */
export function currentBuildId(now: number = Date.now()): string {
  if (cached && now - cached.at < CACHE_MS) return cached.id;
  // `dist/` — this file lives in `dist/` once compiled, so its own directory
  // IS the tree to measure. In a test or a ts-node run it resolves to `src`,
  // which is equally correct: the point is "the code this process loads".
  const root = dirname(fileURLToPath(import.meta.url));
  const id = buildIdOf(root, now);
  cached = { at: now, id };
  return id;
}

/**
 * Is a runner reporting this id executing something other than what the
 * server would start now?
 *
 * `undefined` — a runner old enough not to report a build at all — is STALE
 * by definition: the field was added in the same change as this check, so a
 * runner without it predates everything since.
 */
export function runnerIsStale(reported: string | undefined, current = currentBuildId()): boolean {
  return reported !== current;
}

/** Test seam: forget the cached id. */
export function resetBuildIdCache(): void {
  cached = null;
}
