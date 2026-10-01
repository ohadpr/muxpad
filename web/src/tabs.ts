import { type Tab, sortSidebarTabs } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { api } from './api';
import { subscribe, subscribeReconnect } from './events';
import { mergeWorkspaceTabs, refreshCorpusForTab } from './lib/all-tabs';
import { unreadRowPatch } from './lib/tab-unread';
import { refreshWorkspaces } from './workspaces';

/**
 * Per-workspace tabs hook. Each workspace has its own cache slot, so
 * navigating from workspace A → B never shows A's tabs in B's bar:
 * useTabs(B) reads B's slot (empty until refreshed, not A's stale list).
 *
 * Auto-refreshes on visibilitychange/focus and polls every 5s while
 * visible. The poll is what surfaces per-tab attention flags on tabs
 * the user isn't actively looking at.
 */
const VISIBLE_POLL_MS = 5000;

const caches = new Map<string, Tab[]>();
const listenersByWs = new Map<string, Set<(t: Tab[]) => void>>();
const versions = new Map<string, number>();

/**
 * When each workspace's list last landed. See FRESH_MS in workspaces.ts for
 * why an in-flight coalescer alone isn't enough at boot.
 */
const settledAt = new Map<string, number>();
const FRESH_MS = 2000;
function isFresh(workspaceId: string): boolean {
  return Date.now() - (settledAt.get(workspaceId) ?? 0) < FRESH_MS;
}

export async function refreshTabs(workspaceId: string): Promise<void> {
  if (!workspaceId) return;
  const myVersion = (versions.get(workspaceId) ?? 0) + 1;
  versions.set(workspaceId, myVersion);
  const next = await api.listTabs(workspaceId);
  if ((versions.get(workspaceId) ?? 0) > myVersion) {
    // A newer writer superseded us, so this answer is stale and MUST NOT land.
    //
    // But it must not simply evaporate either, and it used to. Two things
    // changed that from theory into a real hazard: `applyTabRow` bumps the
    // version on every server-pushed row, so the window is now entered by
    // ordinary background traffic rather than only by a user's own drag; and
    // this function is what the pinned-tab escape hatch relies on to fix the
    // divider, so a discarded answer there leaves the list visibly wrong until
    // the 5s poll — indefinitely for a collapsed workspace or a hidden
    // document, which is the exact case the live path exists to serve.
    //
    // So: re-queue on the shared debounce rather than return silently. It
    // cannot spin — the retry is only armed by an actual discard.
    pendingWorkspaceRefresh.add(workspaceId);
    scheduleLiveRefresh();
    // `settledAt` is deliberately NOT stamped: the list did not land, so
    // nothing about the cache got fresher. Marking it fresh here is what let a
    // superseded fetch satisfy `freshTabs`, which resolves a tab's slug — a
    // cold load of a just-created tab could answer "tab not found" and
    // navigate away from it (pages/TabView.tsx).
    return;
  }
  settledAt.set(workspaceId, Date.now());
  caches.set(workspaceId, next);
  const subs = listenersByWs.get(workspaceId);
  if (subs) for (const fn of subs) fn(next);
  // ─── …and on into the cross-workspace corpus ───────────────────────────────
  // A LANDED LIST IS THE ONE THING A PUSH CANNOT REPLACE. `lib/all-tabs` is
  // push-only with no poll by design, which leaves it blind to the single field
  // no push carries: a tab's rolled-up `status`. That moves on `pane.updated`
  // (the refetch scheduled below is this module's answer to it) and on no
  // `tab.updated` at all — so the corpus froze that field at whatever its last
  // fetch said, and finished agents went on spinning as cards beside sidebar
  // rows that had already moved to the done drawer. Same truth, two clocks.
  //
  // Handing the corpus the list we just landed costs NO request — it is an
  // answer fetched anyway — and makes the rail and the cards the same bytes.
  // Every refetch this module already does (5s visible poll, pane status edge,
  // reconnect) therefore refreshes the corpus too, for free.
  //
  // Only here, not in `applyTabRow`: see the note there. And a no-op unless a
  // corpus is actually held, so all-tabs' laziness is untouched.
  mergeWorkspaceTabs(workspaceId, next);
}

/**
 * Whatever tabs are already cached for a workspace, with NO fetch of any kind.
 *
 * The sidebar search box's fallback corpus: the box's real source is one
 * cross-workspace read taken on first focus, and until that lands the first
 * keystroke has to match against something. These slots hold every workspace
 * the user has actually expanded — which on any real session is the ones they
 * are most likely to be looking for.
 */
export function cachedTabsFor(workspaceId: string): Tab[] {
  return caches.get(workspaceId) ?? [];
}

/**
 * Splice a tab the server has JUST CONFIRMED into its workspace's cache.
 *
 * This is not an optimistic row and it cannot leave a ghost: the only caller
 * passes the body of a successful `POST /api/tabs`, so the row already exists
 * server-side with the id and slug written here. A failed create throws before
 * reaching this, and nothing is inserted.
 *
 * WHY IT IS NEEDED. Creating used to `await refreshTabs()` before navigating,
 * so the list was guaranteed to contain the new tab by the time TabView looked
 * for its slug. Navigating immediately removes that guarantee, and the gap is
 * not benign: TabView resolves `tabSlug` through `freshTabs`, which serves the
 * cache without a refetch while it is fresh (FRESH_MS) — and a list that
 * landed a second before the create is fresh AND has no such slug in it. That
 * is TabView's "tab not found" path, which bounces to the workspace root. The
 * user would tap New chat and be thrown out of the chat they just made.
 *
 * So the cache is told directly rather than being raced for. `tab.added` still
 * arrives over the socket and still drives the corpus and the workspace
 * rollup — this only closes the one window that navigation reads
 * synchronously. A no-op for a workspace with no cache slot: there is no stale
 * list to correct, and `freshTabs` will fetch.
 */
export function insertTabRow(workspaceId: string, tab: Tab): void {
  const list = caches.get(workspaceId);
  if (!list) return;
  if (list.some((t) => t.id === tab.id)) return; // the push beat us here
  // Same version bump as applyTabRow / applyTabOrder: a refresh that started
  // before this insert must not land after it and drop the row again.
  versions.set(workspaceId, (versions.get(workspaceId) ?? 0) + 1);
  const merged = sortSidebarTabs([...list, tab]);
  caches.set(workspaceId, merged);
  const subs = listenersByWs.get(workspaceId);
  if (subs) for (const fn of subs) fn(merged);
}

/**
 * A tab list that is current "enough", without a guaranteed round trip.
 *
 * For callers that want to re-derive something from the server's list (e.g.
 * resolving a slug on tab load) but have no write of their own to read back.
 * Going through the shared cache means a cold boot doesn't issue a second
 * identical GET a few milliseconds after the mount refresh — which is exactly
 * what a raw `api.listTabs()` did.
 */
export async function freshTabs(workspaceId: string): Promise<Tab[]> {
  if (!workspaceId) return [];
  const inflight = inFlightMount.get(workspaceId);
  if (inflight) await inflight.catch(() => {});
  else if (!isFresh(workspaceId)) await refreshTabs(workspaceId);
  return caches.get(workspaceId) ?? [];
}

// ── Live decoration refresh ──────────────────────────────────────────────
// The 5s poll surfaces status on tabs you're not looking at, but a working
// ring that lags 5s reads as broken. `pane.updated` lets us refresh promptly.
// BUT pane.updated also fires on title/fg/cwd churn — only the status channel
// affects the tab/workspace lists, so we gate on a per-pane signature and
// ignore events that don't change it. Without this gate a title-churning pane
// (vim, a clock, a streaming session) would drive /tabs + /workspaces refetches
// at the debounce rate for its whole lifetime. We also only refetch a workspace
// whose cached tab list contains the changed tab.
//
// The signature MUST cover every field the lists render. It keyed on
// (busy, attention) alone, which quietly swallowed two things once the status
// model landed: a second subagent starting (`agents` 1→2 — the badge shows the
// number) and a question arriving mid-turn (`status` working→blocked while
// `busy` stayed true). Both edges went dark until the 5s poll happened along.
let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const pendingWorkspaceRefresh = new Set<string>();
const lastPaneStatus = new Map<string, string>();

/** Coalesce every queued workspace refetch into one pass, 250ms out. */
function scheduleLiveRefresh(): void {
  if (liveRefreshTimer !== null) return;
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = null;
    const wss = [...pendingWorkspaceRefresh];
    pendingWorkspaceRefresh.clear();
    for (const wsId of wss) void refreshTabs(wsId);
    // Keep the collapsed-workspace attention rollup live too.
    void refreshWorkspaces();
  }, 250);
}

/**
 * Merge a server-pushed tab row into every cache slot holding it.
 *
 * ─── Why a PATCH and not a refetch ───────────────────────────────────────
 * `tab.updated` used to reach this module not at all: main.tsx handled it
 * with `refreshWorkspaces()` alone, so a renamed tab, a new headline or a new
 * icon sat invisible until the 5s poll — and indefinitely for a workspace
 * whose poll is stopped (collapsed, or the document hidden). HeadlineWriter
 * emits the event precisely to avoid that wait, and the wait happened anyway.
 *
 * The event already carries the whole decorated row (every emitter goes
 * through `decorateTab` for exactly this reason), so there is nothing to fetch:
 * splicing it in is a round trip saved.
 *
 * ─── …and why it now RE-SORTS ────────────────────────────────────────────
 * The splice used to leave the array ORDER alone, on the reasoning that the
 * server owns the order and an in-place replacement therefore cannot make a row
 * jump under the cursor. True, and it made the sidebar wrong: `tab.updated`
 * fires on every `last_activity_at` write, so the row that had just become the
 * most recently active one kept its old rank until the next 5s poll — and
 * indefinitely while that poll is stopped, which it is for a collapsed
 * workspace or a hidden document. On a second device, which is backgrounded
 * most of the time, the order was reliably minutes stale. Reported as "the
 * sidebar doesn't reorder properly and fast enough, on main device and on
 * secondary devices".
 *
 * The hazard the old reasoning was protecting against is real but already
 * owned: `freezeActiveTab` (lib/tab-freeze.ts) holds the row you are ON where
 * you found it and lets everything else re-sort around it — which that file
 * calls "the whole point of a living sidebar". So the two were contradicting
 * each other, and the freeze is the one that is right.
 *
 * Sorting locally rather than refetching keeps the round trip saved and cannot
 * go out of sync, because both sides now run the SAME comparator
 * (`sortSidebarTabs`, shared/src/tab-order.ts). `position` is passed from the
 * rows we hold; it is only a tiebreak between two tabs with identical attention
 * AND activity, so a stale one cannot reorder anything that actually differs.
 *
 * ─── The one thing a patch cannot do ─────────────────────────────────────
 * `pinned` is the single field of the row that the ORDER has to agree with:
 * NavTree draws the pinned/unpinned divider at `tabs.filter(t => t.pinned)
 * .length`, so a flip patched into the middle of the list would put the
 * divider in the wrong place until the next poll. That case — a pin toggled
 * on another device — takes the refetch instead. (The local pin button already
 * refetches on its own; this is for the echo.)
 *
 * ─── The known, priced race ──────────────────────────────────────────────
 * Replacing the row wholesale can briefly undo `applyTabUnread`'s optimistic
 * patch: between the mark-unread tap and its own refetch, an UNRELATED
 * `tab.updated` for that tab (a headline landing, an activity bump) carries
 * the server's pre-write `unread`, and the splice writes it. `POST /unread`
 * emits nothing, so the write's own echo is not the problem — only a
 * coincident one, inside a window one round trip wide.
 *
 * Left alone deliberately. It is self-correcting — `setTabUnread` refetches,
 * and the server's answer is right — so the visible cost is a bold name
 * flickering once, where the fix is a local-intent map with its own lifetime
 * and expiry (lib/tab-view-mode has one, and it is not small). Recorded so
 * that if it is ever actually seen, it is a known trade rather than a mystery.
 */
function applyTabRow(next: Tab): void {
  for (const [wsId, list] of caches) {
    const i = list.findIndex((t) => t.id === next.id);
    if (i < 0) continue;
    const prev = list[i] as Tab;
    if ((prev.pinned ?? false) !== (next.pinned ?? false)) {
      pendingWorkspaceRefresh.add(wsId);
      scheduleLiveRefresh();
      continue;
    }
    const spliced = [...list];
    spliced[i] = next;
    // Both sides break unpinned ties using wire IDs. The previous array order
    // cannot stand in for the server's stored/manual order after a status or
    // recency change. Pinned rows retain their authoritative manual order.
    const merged = sortSidebarTabs(spliced);
    // Same version bump as applyTabOrder / applyTabUnread: a poll that started
    // before this event must not land after it and undo it.
    versions.set(wsId, (versions.get(wsId) ?? 0) + 1);
    caches.set(wsId, merged);
    const subs = listenersByWs.get(wsId);
    if (subs) for (const fn of subs) fn(merged);
    // NOT merged into the corpus here, deliberately: `lib/all-tabs` subscribes
    // to `tab.updated` itself and has already patched the same row from the
    // same event. Doing it again would publish the group twice per event — a
    // second repaint of every corpus reader, `ChatPane` included — to land
    // bytes that are already there.
  }
}

const unsubLiveRefresh = subscribe((e) => {
  // Forget a removed pane's signature so a recreated id starts clean.
  if (e.type === 'pane.removed') {
    lastPaneStatus.delete(e.pane_id);
    return;
  }
  if (e.type === 'tab.updated') {
    applyTabRow(e.tab);
    return;
  }
  if (e.type !== 'pane.updated') return;
  const status = [
    e.pane.status ?? '',
    e.pane.agents ?? 0,
    // Kept alongside `status` rather than replaced by it: `unread` feeds the
    // bold name independently of the rolled-up status, and `attention`/`busy`
    // are what an older server sends.
    e.pane.unread ?? false,
    e.pane.attention ?? false,
    e.pane.busy ?? false,
  ].join('|');
  if (lastPaneStatus.get(e.pane.id) === status) return; // title/fg-only → no list change
  lastPaneStatus.set(e.pane.id, status);
  let held = false;
  for (const [wsId, list] of caches) {
    if (list.some((t) => t.id === e.tab_id)) {
      pendingWorkspaceRefresh.add(wsId);
      held = true;
    }
  }
  // A status edge for a workspace the SIDEBAR has not loaded still moves rows
  // the corpus renders — the flat 'recent' list spans every visible workspace,
  // and a card can point at another one. Nothing above would refetch for it, so
  // the corpus is asked to refresh itself. Only when no slot holds the tab:
  // when one does, the refetch queued above already feeds the corpus through
  // `mergeWorkspaceTabs`, and asking twice would spend a second request on an
  // answer already on its way.
  if (!held) refreshCorpusForTab(e.tab_id);
  scheduleLiveRefresh();
});
// Events don't replay across a reconnect, and pane.updated only fires on busy
// edges — so a transition missed during a disconnect would stay deduped in
// lastPaneStatus forever (the spinner would wait for the 5s poll). Clear the
// dedup cache so the next live edge schedules a refresh again, AND take the
// baseline refetch this comment always promised: without it the display itself
// stays stale for up to a poll interval (and indefinitely for a workspace whose
// poll is stopped because it's collapsed / the document is hidden).
// (The workspace list's own reconnect refetch is wired in main.tsx.)
subscribeReconnect(() => {
  lastPaneStatus.clear();
  for (const wsId of caches.keys()) void refreshTabs(wsId);
});

// Vite HMR: dispose the subscription (and any pending debounce) so editing this
// module in dev doesn't stack duplicate handlers or fire a stale timer. No-op
// in production.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubLiveRefresh();
    if (liveRefreshTimer !== null) clearTimeout(liveRefreshTimer);
  });
}

/**
 * Optimistically reorder a workspace's cached tabs so the sidebar moves the
 * row immediately, before the reorder round-trip. Bumps the per-workspace
 * version so an in-flight poll-refresh is discarded; the caller's own
 * refreshTabs() afterwards reconciles. No-op if `ids` doesn't cover the set.
 */
export function applyTabOrder(workspaceId: string, ids: string[]): void {
  const current = caches.get(workspaceId);
  if (!current) return;
  const byId = new Map(current.map((t) => [t.id, t]));
  const next = ids.map((id) => byId.get(id)).filter((t): t is Tab => t !== undefined);
  if (next.length !== current.length) return;
  versions.set(workspaceId, (versions.get(workspaceId) ?? 0) + 1);
  caches.set(workspaceId, next);
  const subs = listenersByWs.get(workspaceId);
  if (subs) for (const fn of subs) fn(next);
}

/**
 * Optimistically flip one tab's manual unread mark in whatever workspace slot
 * holds it, so the row's bold name and status dot land on the tap's own frame
 * rather than after the write's round trip. See lib/tab-unread for the shape
 * of the patch (and why it patches `status` as well as `unread`).
 *
 * Scans the cache slots rather than taking a workspaceId: the callers that
 * have one (NavTree) also have the tab, and the ones that don't would have to
 * invent it. Patching every slot that holds the tab is also what keeps the
 * OTHER readers of this cache honest for free — the tab-bar dropdown and the
 * mobile switcher both render from it and pick the flip up in the same frame.
 *
 * Same bump-the-version trick as applyTabOrder — an in-flight poll that
 * started before this patch must not land after it and undo it. The caller's
 * own refreshTabs() is issued AFTER the bump, so it takes a higher version and
 * its answer still wins; only the older poll is discarded.
 *
 * DELIBERATELY PARTIAL. This patches the tab row and nothing else, so for one
 * round trip the workspace row's rollup dot above it, and the pane rows inside
 * an expanded tab, still show the pre-tap state. Reproducing decorateWorkspace
 * and the per-pane fan-out of /seen on the client would mean a second
 * implementation of the server's rollup rules, which is a far worse trade than
 * a sibling row lagging by one request — and the refetch behind this fixes
 * them all at once.
 */
export function applyTabUnread(tabId: string, unread: boolean): void {
  for (const [wsId, list] of caches) {
    const i = list.findIndex((t) => t.id === tabId);
    if (i < 0) continue;
    const next = [...list];
    next[i] = { ...list[i], ...unreadRowPatch(list[i] as Tab, unread) } as Tab;
    versions.set(wsId, (versions.get(wsId) ?? 0) + 1);
    caches.set(wsId, next);
    const subs = listenersByWs.get(wsId);
    if (subs) for (const fn of subs) fn(next);
  }
}

// ── One driver PER WORKSPACE, not per subscriber ─────────────────────────
// Same lesson as workspaces.ts: the interval and the focus/visibility handlers
// used to live inside useTabs's effect, so a workspace with N mounted
// consumers (the tab bar, the sidebar's tab list, every visited TabView) ran
// N intervals hitting the same endpoint every 5s and N refetches on every
// focus. The module cache de-duplicated the answer, never the request. Now the
// subscriber count only decides whether the workspace's single driver runs.
interface TabsDriver {
  refs: number;
  timer: number | null;
  onVisible: () => void;
  onFocus: () => void;
}
const drivers = new Map<string, TabsDriver>();

/** Mount-time refetch shared by everything mounting in the same tick. NOT
 *  applied to the exported refreshTabs, which post-mutation callers rely on
 *  to actually re-read after their write. */
const inFlightMount = new Map<string, Promise<void>>();
export function refreshTabsOnMount(workspaceId: string): void {
  if (inFlightMount.has(workspaceId)) return;
  if (isFresh(workspaceId)) return; // another mount just fetched this list
  const p = refreshTabs(workspaceId).finally(() => inFlightMount.delete(workspaceId));
  inFlightMount.set(workspaceId, p);
  p.catch(() => {
    // a failed refresh leaves the cache as it was; the poll retries
  });
}

function acquireDriver(workspaceId: string): void {
  const existing = drivers.get(workspaceId);
  if (existing) {
    existing.refs += 1;
    return;
  }
  const d: TabsDriver = {
    refs: 1,
    timer: null,
    onVisible: () => {},
    onFocus: () => void refreshTabs(workspaceId),
  };
  const start = () => {
    if (d.timer !== null) return;
    d.timer = window.setInterval(() => void refreshTabs(workspaceId), VISIBLE_POLL_MS);
  };
  const stop = () => {
    if (d.timer === null) return;
    window.clearInterval(d.timer);
    d.timer = null;
  };
  d.onVisible = () => {
    if (document.visibilityState === 'visible') {
      void refreshTabs(workspaceId);
      start();
    } else {
      stop();
    }
  };
  drivers.set(workspaceId, d);
  document.addEventListener('visibilitychange', d.onVisible);
  window.addEventListener('focus', d.onFocus);
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
}

function releaseDriver(workspaceId: string): void {
  const d = drivers.get(workspaceId);
  if (!d) return;
  d.refs -= 1;
  if (d.refs > 0) return;
  drivers.delete(workspaceId);
  document.removeEventListener('visibilitychange', d.onVisible);
  window.removeEventListener('focus', d.onFocus);
  if (d.timer !== null) window.clearInterval(d.timer);
}

export function useTabs(workspaceId: string): {
  tabs: Tab[];
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<Tab[]>(() => caches.get(workspaceId) ?? []);
  // If workspaceId changed since last render and our state hasn't caught
  // up yet, sync state to the new workspace's cache slot synchronously
  // during render. Avoids a flash of the previous workspace's tabs when
  // TabBar / WorkspaceLayout re-render with a different workspaceId.
  const [prevWs, setPrevWs] = useState(workspaceId);
  if (prevWs !== workspaceId) {
    setPrevWs(workspaceId);
    setState(caches.get(workspaceId) ?? []);
  }

  useEffect(() => {
    if (!workspaceId) return;
    let subs = listenersByWs.get(workspaceId);
    if (!subs) {
      subs = new Set();
      listenersByWs.set(workspaceId, subs);
    }
    subs.add(setState);
    refreshTabsOnMount(workspaceId);
    acquireDriver(workspaceId);
    return () => {
      subs!.delete(setState);
      releaseDriver(workspaceId);
    };
  }, [workspaceId]);

  return { tabs: state, refresh: () => refreshTabs(workspaceId) };
}
