import type { Tab } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { api } from './api';
import { subscribe, subscribeReconnect } from './events';
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
  settledAt.set(workspaceId, Date.now());
  if ((versions.get(workspaceId) ?? 0) > myVersion) return; // a newer call superseded us
  caches.set(workspaceId, next);
  const subs = listenersByWs.get(workspaceId);
  if (subs) for (const fn of subs) fn(next);
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
 * splicing it in is a round trip saved AND — the part that matters more —
 * it leaves the ARRAY ORDER alone. The server owns the order (pinned block,
 * then attention → recency) and the client only renders the sequence it was
 * given, so an in-place replacement cannot make a row jump under the cursor.
 * A refetch here would have: `tab.updated` also fires on every
 * `last_activity_at` write, so wiring this to a refetch would have turned the
 * unpinned block into a list that re-sorts on every finished turn, at the
 * debounce rate, everywhere except the one frozen active row.
 *
 * ─── The one thing a patch cannot do ─────────────────────────────────────
 * `pinned` is the single field of the row that the ORDER has to agree with:
 * NavTree draws the pinned/unpinned divider at `tabs.filter(t => t.pinned)
 * .length`, so a flip patched into the middle of the list would put the
 * divider in the wrong place until the next poll. That case — a pin toggled
 * on another device — takes the refetch instead. (The local pin button already
 * refetches on its own; this is for the echo.)
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
    const merged = [...list];
    merged[i] = next;
    // Same version bump as applyTabOrder / applyTabUnread: a poll that started
    // before this event must not land after it and undo it.
    versions.set(wsId, (versions.get(wsId) ?? 0) + 1);
    caches.set(wsId, merged);
    const subs = listenersByWs.get(wsId);
    if (subs) for (const fn of subs) fn(merged);
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
  for (const [wsId, list] of caches) {
    if (list.some((t) => t.id === e.tab_id)) pendingWorkspaceRefresh.add(wsId);
  }
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
