import { CHAT_DECAY_DAYS, type Tab } from '@muxpad/shared';
import { api } from '../api';
import { subscribe, subscribeResync } from '../events';
import type { WorkspaceTabs } from './nav-search';

/**
 * THE INBOX: every unread chat on the install, FINISHED ONES INCLUDED.
 *
 * `/api/tabs/all` is the live-work corpus and no longer carries finished
 * history, so it cannot answer "what is unread" — a worker that finished four
 * days ago and was never looked at is exactly the row the Unread list exists
 * for. `GET /api/tabs/unread` is that answer: every workspace, in workspace
 * order, each holding only its unread rows in their stored order, report text
 * stripped.
 *
 * ONE store for every reader — the rail's Unread view and badges (NavTree,
 * DestinationRail), the phone's Unread tab and its badge (MobileNav), and the
 * Unread page. They mount together; they share one request (`inFlight`, then
 * `FRESH_MS`), never one each.
 *
 * Kept current by what already happens, not by a poll:
 *
 *   · `mergeUnreadWorkspace` — tabs.ts hands over every workspace list that
 *     lands (5s visible poll, status-edge refetch, reconnect) and every
 *     optimistic unread/order patch. Free, and exact: that list is the whole
 *     workspace in stored order, so its unread subsequence IS this group.
 *   · pushes: `tab.updated` patches or drops a held row; a row that BECOMES
 *     unread (a push, `tab.added`, or a pane's unread bit flipping) schedules
 *     one coalesced refetch, because only the server knows where it sorts.
 *   · `subscribeResync` — reconnect / document-visible, the backstop for any
 *     push that was missed.
 *
 * Refetches are coalesced (250 ms) with a 2 s floor, and only spent while
 * something is mounted to show them. The hooks are in use-unread.ts (kept
 * apart so tabs.ts can feed this store without an import cycle).
 */

let cache: WorkspaceTabs[] | null = null;
let settledAt = 0;
let inFlight: Promise<WorkspaceTabs[]> | null = null;
/** Bumped by everything that knows something newer than a request in flight;
 *  a landing that finds it moved is not published, and is retried. */
let generation = 0;
let supersededRetries = 0;
const MAX_SUPERSEDED_RETRIES = 3;
const FRESH_MS = 4000;
const REFETCH_MS = 250;
const REFETCH_MIN_GAP_MS = 2000;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefetchAt = 0;
let unsupported = false;
const listeners = new Set<(groups: WorkspaceTabs[]) => void>();
/** Last unread bit seen per pane, so only a real edge costs anything. */
const lastPaneUnread = new Map<string, boolean>();

function publish(next: WorkspaceTabs[]): void {
  cache = next;
  for (const fn of listeners) fn(next);
}

/** The same row without its report prose — what the route serves. */
function stripReport(t: Tab): Tab {
  if (!t.spawn_report) return t;
  const { spawn_report: _dropped, ...rest } = t;
  return rest as Tab;
}

/** `clock.fill` is a stopwatch (see all-tabs.ts signatureReplacer): compare it
 *  at the resolution the chip draws, or every landing reads as a change. */
function replacer(key: string, value: unknown): unknown {
  return key === 'fill' && typeof value === 'number'
    ? Math.floor(Math.max(0, Math.min(1, value)) * CHAT_DECAY_DAYS)
    : value;
}
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a, replacer) === JSON.stringify(b, replacer);
}

function holds(tabId: string): boolean {
  return cache?.some((g) => g.tabs.some((t) => t.id === tabId)) ?? false;
}

/** Replace held groups' rows; publishes only when something moved. */
function patchGroups(fn: (g: WorkspaceTabs) => Tab[]): void {
  if (!cache) return;
  let hit = false;
  const next = cache.map((g) => {
    const tabs = fn(g);
    if (tabs === g.tabs) return g;
    hit = true;
    return { ...g, tabs };
  });
  if (!hit) return;
  generation++;
  publish(next);
}

/** Ask the server again, soon — coalesced, floored, and only for a reader. */
function scheduleRefetch(): void {
  settledAt = 0;
  // A request already travelling was asked before this news.
  if (inFlight) generation++;
  if (listeners.size === 0 || refetchTimer !== null) return;
  const since = Date.now() - lastRefetchAt;
  refetchTimer = setTimeout(
    () => {
      refetchTimer = null;
      lastRefetchAt = Date.now();
      settledAt = 0;
      if (inFlight) generation++;
      void loadUnreadTabs();
    },
    Math.max(REFETCH_MS, REFETCH_MIN_GAP_MS - since),
  );
}

/**
 * A workspace's freshly-landed (or optimistically patched) full list, from
 * tabs.ts. Its unread rows, in its order, are this store's group for it.
 */
export function mergeUnreadWorkspace(workspaceId: string, tabs: readonly Tab[]): void {
  if (!cache) {
    if (inFlight) generation++;
    return;
  }
  const next = tabs.filter((t) => t.unread === true).map(stripReport);
  const group = cache.find((g) => g.id === workspaceId);
  if (!group) {
    // A workspace newer than our answer — the server knows its name; ask.
    if (next.length > 0) scheduleRefetch();
    return;
  }
  if (same(group.tabs, next)) return;
  patchGroups((g) => (g.id === workspaceId ? next : g.tabs));
}

const unsubscribeLive = subscribe((e) => {
  if (e.type === 'pane.removed') {
    lastPaneUnread.delete(e.pane_id);
    if (holds(e.tab_id)) scheduleRefetch();
    return;
  }
  if (e.type === 'pane.updated') {
    const now = e.pane.unread === true;
    const before = lastPaneUnread.get(e.pane.id);
    lastPaneUnread.set(e.pane.id, now);
    if (before === now) return;
    const held = holds(e.tab_id);
    // Already listed and this pane only joined it: nothing to learn.
    if (now && held) return;
    // First sighting that agrees with what we hold: nothing to learn either.
    if (before === undefined && !now && !held) return;
    scheduleRefetch();
    return;
  }
  if (!cache) {
    if (
      inFlight &&
      (e.type === 'tab.updated' || e.type === 'tab.added' || e.type === 'tab.removed')
    )
      generation++;
    return;
  }
  if (e.type === 'tab.updated') {
    const row = stripReport(e.tab);
    const held = holds(row.id);
    if (!held) {
      if (row.unread === true) scheduleRefetch();
      return;
    }
    if (row.unread !== true) {
      patchGroups((g) =>
        g.tabs.some((t) => t.id === row.id) ? g.tabs.filter((t) => t.id !== row.id) : g.tabs,
      );
      return;
    }
    patchGroups((g) => {
      const i = g.tabs.findIndex((t) => t.id === row.id);
      if (i < 0) return g.tabs;
      const prev = g.tabs[i] as Tab;
      // A pin flip moves the row across the divider; only the server's order
      // says where to.
      if ((prev.pinned ?? false) !== (row.pinned ?? false)) scheduleRefetch();
      if (same(prev, row)) return g.tabs;
      const tabs = [...g.tabs];
      tabs[i] = row;
      return tabs;
    });
    return;
  }
  if (e.type === 'tab.added') {
    if (e.tab.unread === true && !holds(e.tab.id)) scheduleRefetch();
    return;
  }
  if (e.type === 'tab.removed') {
    patchGroups((g) =>
      g.tabs.some((t) => t.id === e.tab_id) ? g.tabs.filter((t) => t.id !== e.tab_id) : g.tabs,
    );
    return;
  }
  if (e.type === 'tabs.reordered') {
    const g = cache.find((x) => x.id === e.workspace_id);
    if (g && g.tabs.length > 1) scheduleRefetch();
  }
});

const unsubscribeResync = subscribeResync(() => {
  // Pushes are not replayed: forget the edge memo so the next one counts.
  lastPaneUnread.clear();
  settledAt = 0;
  if (!cache || listeners.size === 0) return;
  if (inFlight) generation++;
  void loadUnreadTabs();
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeLive();
    unsubscribeResync();
    if (refetchTimer !== null) clearTimeout(refetchTimer);
    listeners.clear();
  });
}

export function cachedUnreadTabs(): WorkspaceTabs[] | null {
  return cache;
}

/** Hear the inbox change. Does not fetch — `loadUnreadTabs` does. */
export function subscribeUnreadTabs(fn: (groups: WorkspaceTabs[]) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Fetch the inbox — coalesced across callers, skipped while fresh. Resolves
 *  to what is held (or []) on failure rather than rejecting. */
export async function loadUnreadTabs(): Promise<WorkspaceTabs[]> {
  if (unsupported) return cache ?? [];
  if (cache && Date.now() - settledAt < FRESH_MS) return cache;
  if (inFlight) return inFlight;
  const issuedAt = generation;
  let superseded = false;
  // Through a resolved promise so even a synchronous throw lands in `.catch`
  // below: a reader's mount must never surface as an unhandled rejection.
  inFlight = Promise.resolve()
    .then(() => api.listUnreadTabs())
    .then((res) => {
      if (generation !== issuedAt) {
        superseded = true;
        if (cache) return cache;
        publish(res.workspaces);
        return res.workspaces;
      }
      supersededRetries = 0;
      settledAt = Date.now();
      if (cache && same(cache, res.workspaces)) return cache;
      publish(res.workspaces);
      return res.workspaces;
    })
    .catch((err: unknown) => {
      if ((err as { status?: number } | null)?.status === 404) unsupported = true;
      return cache ?? [];
    })
    .finally(() => {
      inFlight = null;
      if (superseded && supersededRetries < MAX_SUPERSEDED_RETRIES) {
        supersededRetries++;
        void loadUnreadTabs();
      }
    });
  return inFlight;
}

/** Test seam. */
export function resetUnreadTabsCache(): void {
  cache = null;
  settledAt = 0;
  inFlight = null;
  generation = 0;
  supersededRetries = 0;
  unsupported = false;
  if (refetchTimer !== null) clearTimeout(refetchTimer);
  refetchTimer = null;
  lastRefetchAt = 0;
  lastPaneUnread.clear();
  listeners.clear();
}
