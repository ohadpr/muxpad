import type { Tab } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { api } from './api';
import { subscribe, subscribeReconnect } from './events';
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

export async function refreshTabs(workspaceId: string): Promise<void> {
  if (!workspaceId) return;
  const myVersion = (versions.get(workspaceId) ?? 0) + 1;
  versions.set(workspaceId, myVersion);
  const next = await api.listTabs(workspaceId);
  if ((versions.get(workspaceId) ?? 0) > myVersion) return; // a newer call superseded us
  caches.set(workspaceId, next);
  const subs = listenersByWs.get(workspaceId);
  if (subs) for (const fn of subs) fn(next);
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
const unsubLiveRefresh = subscribe((e) => {
  // Forget a removed pane's signature so a recreated id starts clean.
  if (e.type === 'pane.removed') {
    lastPaneStatus.delete(e.pane_id);
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
  if (liveRefreshTimer !== null) return;
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = null;
    const wss = [...pendingWorkspaceRefresh];
    pendingWorkspaceRefresh.clear();
    for (const wsId of wss) void refreshTabs(wsId);
    // Keep the collapsed-workspace attention rollup live too.
    void refreshWorkspaces();
  }, 250);
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
function refreshOnMount(workspaceId: string): void {
  if (inFlightMount.has(workspaceId)) return;
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
    refreshOnMount(workspaceId);
    acquireDriver(workspaceId);
    return () => {
      subs!.delete(setState);
      releaseDriver(workspaceId);
    };
  }, [workspaceId]);

  return { tabs: state, refresh: () => refreshTabs(workspaceId) };
}
