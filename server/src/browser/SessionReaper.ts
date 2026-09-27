import { SESSION_PROFILE_PREFIX } from './SessionBrowser.js';

/**
 * Stopping session browsers whose session is gone.
 *
 * Each one is a real Chrome, roughly 200 MB. One per agent tab, never
 * collected, on a machine that routinely has fifteen sessions open — that is
 * the memory complaint this whole project started from, rebuilt out of my own
 * parts. So they are swept.
 *
 * TWO REFUSALS, both deliberate:
 *
 *   · a profile without the session prefix is never touched. `default` is the
 *     browser a person logs into and the source of the shared jar; reaping it
 *     would throw away every login on the machine.
 *   · an UNKNOWN tab list reaps nothing. A failed read that returns an empty
 *     set looks identical to "there are no tabs", and acting on it would close
 *     every browser at once. Null says "I do not know", and the answer to that
 *     is always to do nothing.
 */
export function sessionBrowsersToReap(
  browsers: ReadonlyArray<{ profile: string }>,
  liveTabIds: ReadonlySet<string> | null,
): string[] {
  if (!liveTabIds) return [];
  // Profile names are lowercased and a ULID is not, so compare on one case.
  // Raw comparison would find no match for any live tab and reap all of them.
  const live = new Set([...liveTabIds].map((id) => id.toLowerCase()));
  return browsers
    .filter((b) => b.profile.startsWith(SESSION_PROFILE_PREFIX))
    .filter((b) => !live.has(b.profile.slice(SESSION_PROFILE_PREFIX.length)))
    .map((b) => b.profile);
}
