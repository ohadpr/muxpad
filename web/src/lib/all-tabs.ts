import { api } from '../api';
import type { WorkspaceTabs } from './nav-search';

/**
 * The cross-workspace tab corpus behind the sidebar search box.
 *
 * LAZY BY CONSTRUCTION. Nothing here runs until the box is focused for the
 * first time — the user has complained about mobile load time, and a corpus
 * fetch on mount would put a request the first paint doesn't need in front of
 * the one it does. Until then the box falls back to whatever the per-workspace
 * caches already hold (see NavSearch), so the FIRST keystroke is never empty
 * even though nothing has been fetched for it.
 *
 * There is no poll. A search session is seconds long; the corpus is refreshed
 * on focus when it has gone stale and otherwise left alone, which keeps the
 * cost of the feature at "one request per time you go looking for something".
 */

let cache: WorkspaceTabs[] | null = null;
let settledAt = 0;
let inFlight: Promise<WorkspaceTabs[]> | null = null;

/**
 * A corpus younger than this is reused as-is. Sized to cover a focus →
 * type → focus-again cycle (the box is refocused by every Esc-and-retry)
 * without going back to the server, while staying under the 5s tab poll so
 * search never shows a list that is older than the tree beside it.
 */
const FRESH_MS = 4000;

/**
 * Set once `/api/tabs/all` has answered 404 — an older server that predates
 * the route. Sticky for the page's lifetime: retrying it on every focus would
 * spend a request per keystroke session to learn the same thing again.
 */
let unsupported = false;

/** Whatever corpus we already have, without asking for one. */
export function cachedAllTabs(): WorkspaceTabs[] | null {
  return cache;
}

/**
 * Fetch the corpus, coalescing concurrent callers and skipping the round trip
 * entirely while the cached answer is fresh. Resolves to the previous corpus
 * (or an empty list) on failure rather than rejecting — the caller has a
 * usable fallback and a search box that throws on focus is worse than one that
 * matches slightly less.
 */
export async function loadAllTabs(): Promise<WorkspaceTabs[]> {
  if (unsupported) return cache ?? [];
  if (cache && Date.now() - settledAt < FRESH_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = api
    .listAllTabs()
    .then((res) => {
      cache = res.workspaces;
      settledAt = Date.now();
      return cache;
    })
    .catch((err: unknown) => {
      // 404 = the route isn't there (older server). Anything else is a blip
      // worth retrying on the next focus.
      if ((err as { status?: number } | null)?.status === 404) unsupported = true;
      return cache ?? [];
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test seam — drops the module cache and the unsupported latch. */
export function resetAllTabsCache(): void {
  cache = null;
  settledAt = 0;
  inFlight = null;
  unsupported = false;
}
