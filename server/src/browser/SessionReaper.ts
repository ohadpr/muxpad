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

/**
 * Whether a reaped session browser's leftovers can be deleted.
 *
 * STOPPING IS NOT ENOUGH, and this is the fault that made a hundred rows.
 * Reaping only stopped the process, which left the app row behind disabled —
 * and the sweep skipped disabled rows, so nothing ever looked at them again.
 * `muxpad app list` grew one permanent row per agent session ever opened, each
 * still holding a port out of a hundred-port space, and each still holding a
 * profile directory on disk. Ninety-nine of them by the time it was noticed.
 *
 * A session profile is safe to delete outright: its tab is gone and a tab id is
 * never reissued, so nothing can ever want it again, and it holds no logins
 * worth keeping — agents read cookies from the SHARED jar, which lives
 * elsewhere and belongs to the browser a person drives.
 *
 * The guard is on the name, because the consequence of getting it wrong is
 * deleting the directory holding every login on the machine. Only a profile
 * carrying the session prefix and no path syntax at all may be removed.
 */
export function isDisposableSessionProfile(profile: string): boolean {
  if (!profile.startsWith(SESSION_PROFILE_PREFIX)) return false;
  // Belt and braces over normalizeProfileName: this answer authorises an rm -rf.
  if (profile.includes('/') || profile.includes('\\') || profile.includes('..')) return false;
  // A prefix and nothing after it is not a session; it is the prefix.
  return profile.length > SESSION_PROFILE_PREFIX.length;
}

/**
 * Profile DIRECTORIES that no app row names, and may therefore be removed.
 *
 * The row-driven sweep cannot see these: it walks app rows, so a directory
 * whose row is gone is invisible to it forever. They exist because the reaper
 * used to delete the row BEFORE the directory, so an `rm` that threw — a race
 * with the Chrome still writing into the profile it was being evicted from —
 * left a directory with nothing pointing at it. Measured when it was found: 42
 * of 48 directories stranded, 147 MB. The ordering is fixed; this collects what
 * it already stranded, and anything a future failure strands between passes.
 *
 * PURE, and separated from the rm that acts on it, because the consequence of
 * getting the name wrong is deleting `browser-profiles/default` — the directory
 * holding every login on the machine. A decision that authorises an rm -rf is
 * worth being able to test exhaustively, which a function reading a real
 * directory is not.
 */
export function strandedProfilesToRemove(
  /** Every entry in the profiles directory — files included, as readdir gives it. */
  entries: readonly string[],
  /** Profiles an app row still names; theirs is the sweep above, not this one. */
  known: ReadonlySet<string>,
): string[] {
  return entries.filter((name) => isDisposableSessionProfile(name) && !known.has(name));
}
