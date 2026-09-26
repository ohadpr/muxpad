import { api } from '../api';
import { subscribe } from '../events';
import type { WorkspaceTabs } from './nav-search';

/**
 * The cross-workspace tab corpus behind the sidebar search box and the `@`
 * picker.
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
 *
 * ─── …but it is LIVE, because it outlived the search session ─────────────────
 * That reasoning was written for a search box: open it, type, choose, done. The
 * `@` picker put the same corpus behind things that stay on screen for hours —
 * the chip inside a sent message, and the card for work directed to another
 * chat. Those resolve a chat every render and had no way to hear that it had
 * been renamed, archived, retired or revived: a `ChatPane` took its own snapshot
 * on first use and nothing ever refreshed it. The sidebar moved; the chip in the
 * conversation next to it did not.
 *
 * So the cache follows the same server pushes the tab cache does (`tab.updated`
 * / `.added` / `.removed`) and notifies its readers. Same trade as `tabs.ts`
 * `applyTabRow`: the event already carries the whole decorated row, so a patch
 * is a round trip saved and cannot drift from what the sidebar is showing —
 * because it IS what the sidebar is showing. No poll was added; there is still
 * exactly one request per time you go looking for something.
 */

let cache: WorkspaceTabs[] | null = null;
let settledAt = 0;
let inFlight: Promise<WorkspaceTabs[]> | null = null;
const listeners = new Set<(groups: WorkspaceTabs[]) => void>();

function publish(next: WorkspaceTabs[]): void {
  cache = next;
  for (const fn of listeners) fn(next);
}

/**
 * Hear about the corpus changing — a fetch landing, or a server push.
 *
 * Returns the unsubscribe, and does NOT fetch: a caller that wants a corpus asks
 * for one with `loadAllTabs`. Subscribing is how you stop holding a stale copy,
 * not how you get a first one.
 */
export function subscribeAllTabs(fn: (groups: WorkspaceTabs[]) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Splice a server-pushed row into the corpus, if we are holding one.
 *
 * Nothing is FETCHED here, by design: the corpus is lazy, and a `tab.updated`
 * for a workspace nobody has asked about must not turn into a request. A row we
 * do not hold is simply not our business yet — the next `loadAllTabs` gets it.
 */
const unsubscribeLive = subscribe((e) => {
  if (!cache) return;
  if (e.type === 'tab.updated') {
    let hit = false;
    const next = cache.map((g) => {
      const i = g.tabs.findIndex((t) => t.id === e.tab.id);
      if (i < 0) return g;
      hit = true;
      const tabs = [...g.tabs];
      tabs[i] = e.tab;
      return { ...g, tabs };
    });
    // Order is NOT touched. This corpus is ranked per query (rankMentions /
    // rankTabs) rather than displayed in its stored order, so re-sorting it
    // would be work with no reader — and `sortSidebarTabs` is the sidebar's
    // business, applied to the sidebar's own cache.
    if (hit) publish(next);
    return;
  }
  if (e.type === 'tab.added') {
    const has = cache.some((g) => g.tabs.some((t) => t.id === e.tab.id));
    if (has) return;
    let hit = false;
    const next = cache.map((g) => {
      if (g.id !== e.workspace_id) return g;
      hit = true;
      return { ...g, tabs: [...g.tabs, e.tab] };
    });
    // A workspace we are not holding: leave it to the next fetch rather than
    // inventing a group out of an id and no name.
    if (hit) publish(next);
    return;
  }
  if (e.type === 'tab.removed') {
    let hit = false;
    const next = cache.map((g) => {
      if (!g.tabs.some((t) => t.id === e.tab_id)) return g;
      hit = true;
      return { ...g, tabs: g.tabs.filter((t) => t.id !== e.tab_id) };
    });
    if (hit) publish(next);
  }
});

// Vite HMR: same reasoning as tabs.ts — editing this module in dev must not
// stack duplicate handlers. No-op in production.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeLive();
    listeners.clear();
  });
}

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
      settledAt = Date.now();
      publish(res.workspaces);
      return res.workspaces;
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

/** Test seam — drops the module cache, the latch, and every subscriber. */
export function resetAllTabsCache(): void {
  cache = null;
  settledAt = 0;
  inFlight = null;
  unsupported = false;
  listeners.clear();
}
