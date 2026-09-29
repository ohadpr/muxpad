import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chrome's profile lock, after an unclean exit.
 *
 * THE FAILURE THIS PREVENTS, observed live. Chrome was killed without a chance
 * to clean up and left `SingletonLock` symlinked to a pid that no longer
 * existed. Every launch after that died immediately —
 *
 *     No rendezvous client, terminating process (parent died?)
 *
 * — so `muxpad serve` restarted the host, and it died again, and again. A
 * crash-loop that no amount of supervision can escape, because the thing
 * blocking it is a file on disk. The browser was permanently broken until
 * somebody deleted it by hand, which is not a thing a user should ever have to
 * know.
 *
 * WHY CLEARING IT IS SAFE HERE, AND WOULD NOT BE ELSEWHERE. One profile has
 * exactly one owner — that is the invariant the whole subsystem is built on
 * (see BrowserProfile.ts), enforced by there being exactly one app row per
 * profile. So when OUR host is starting, no other process may legitimately hold
 * this profile, and a lock that is present is by definition left over. In a
 * world where a user's real Chrome might be using the directory this would be
 * reckless; muxpad's profiles are muxpad's alone.
 */

/** The files Chrome leaves behind, in the order it creates them. */
export function staleLockFiles(profileDir: string): string[] {
  return ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((f) => join(profileDir, f));
}

/**
 * Clears a leftover lock so a restart can actually start.
 *
 * Best-effort: a profile directory that does not exist yet, or a file already
 * gone, is the ordinary case rather than an error.
 */
export function clearStaleProfileLock(profileDir: string): string[] {
  const cleared: string[] = [];
  for (const file of staleLockFiles(profileDir)) {
    try {
      // ASK FIRST. `rmSync` with `force` does not throw for a file that is not
      // there, so removing unconditionally and recording the removal reported
      // all three as cleared on every clean start — a return value describing
      // work that never happened. Nothing reads it today; the next thing to
      // read it would have been told a story.
      if (!existsSync(file)) continue;
      rmSync(file, { force: true });
      cleared.push(file);
    } catch {
      // Nothing to do about it, and nothing depends on it having worked: the
      // launch below will fail loudly if the lock really is held.
    }
  }
  return cleared;
}
