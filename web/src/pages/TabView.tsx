import type { LayoutNode, PaneSpec } from '@muxpad/shared';
import { collectLayoutLeaves, isAgentPane, rowNounTitle } from '@muxpad/shared';
import { useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type TabWithPanes, api } from '../api';
import { ExternalOpenToasts } from '../components/ExternalOpenToasts';
import { MobileInputBar } from '../components/MobileInputBar';
import { PaneWebSwitch } from '../components/PaneWebSwitch';
import { ShellPaneBody } from '../components/ShellPaneBody';
import { UrlPane } from '../components/UrlPane';
import { subscribe, subscribeResync } from '../events';
import { HOUSE_CHAT_PANE_CREATE } from '../lib/agent-backend';
import { consumeFollowTarget } from '../lib/follow-tab';
import { getLastPaneId, setLastPaneId, setLastTabSlug } from '../lib/last-visited';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import { consumePushFocusPane } from '../lib/push-focus';
import { documentVisible, seenAckTarget, useDocumentVisible } from '../lib/seen-ack';
import { applyTabUpdated, fetchUnsuperseded, mergePaneUpdated } from '../lib/tab-detail-events';
import { freshTabs, refreshTabs, useTabs } from '../tabs';
import { useMediaQuery } from '../use-media-query';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';

import './tab.css';

/**
 * A tab's layout, with `null` for "holds nothing". The wire spells empty as
 * `''`; these two keep that spelling at the edge.
 *
 * Still a tree type, because an OLD row can carry one: migration 54 split the
 * last split tabs, and the server now refuses to write another (routes/tabs.ts,
 * routes/panes.ts), but reading defensively costs nothing.
 */
type Layout = LayoutNode | null;

function toLayout(layout: LayoutNode): Layout {
  return layout === '' ? null : layout;
}

function fromLayout(layout: Layout): LayoutNode {
  return layout ?? '';
}

function removePane(layout: Layout, paneId: string): Layout {
  if (layout == null) return null;
  if (typeof layout === 'string') return layout === paneId ? null : layout;
  const first = removePane(layout.first as Layout, paneId);
  const second = removePane(layout.second as Layout, paneId);
  if (first == null) return second;
  if (second == null) return first;
  return { ...layout, first, second };
}

/**
 * Per-tab serialization of outbound whole-layout PATCHes.
 *
 * Module-level (not a ref) on purpose: it must survive TabView remounting and
 * cover every writer of the same tab in this document, which a per-instance
 * chain would not. Entries are keyed by tab id and dropped as soon as their
 * chain drains, so the map stays the size of the tabs currently being edited.
 */
const layoutWriteChains = new Map<string, Promise<unknown>>();

function enqueueLayoutWrite<T>(tabId: string, write: () => Promise<T>): Promise<T> {
  const prior = layoutWriteChains.get(tabId) ?? Promise.resolve();
  // `.then` on the SETTLED prior (failures don't stall the queue) — a rejected
  // write is reported to its own caller, not to the next one in line.
  const mine = prior.then(write, write);
  const tail = mine.then(
    () => {},
    () => {},
  );
  layoutWriteChains.set(tabId, tail);
  void tail.then(() => {
    if (layoutWriteChains.get(tabId) === tail) layoutWriteChains.delete(tabId);
  });
  return mine;
}

/** Walk the binary tree, returning all pane ids in tree order. Delegates to
 *  the shared walker (one traversal, one set of empty-leaf semantics — the
 *  old local copy returned [''] for an empty-string leaf). */
function collectPaneIds(layout: Layout): string[] {
  return collectLayoutLeaves((layout ?? '') as LayoutNode);
}

export interface TabViewProps {
  /** Stable slug for this instance — one TabView per tab in WorkspaceLayout. */
  tabSlug: string;
  /** False while the tab is mounted but hidden during a tab switch. */
  isActive: boolean;
}

/**
 * Paints the active terminal's face switch into
 * the mobile top-bar slot (`#mobile-pane-chrome`, rendered by AppLayout) via a
 * portal, so mobile chrome collapses to a single row. The slot is an ancestor
 * committed before this mounts, so it's in the DOM by the time the effect runs;
 * renders nothing if it's ever absent (desktop / no active workspace).
 */
function MobilePaneChrome({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.getElementById('mobile-pane-chrome'));
  }, []);
  return host ? createPortal(children, host) : null;
}

export function TabView({ tabSlug, isActive }: TabViewProps) {
  const { wsSlug } = useParams({ from: '/_app/w/$wsSlug' });
  const navigate = useNavigate();
  const { workspaces } = useWorkspaces();
  const workspace = workspaces.find((w) => w.slug === wsSlug);
  const { tabs: allTabs } = useTabs(workspace?.id ?? '');

  const [tab, setTab] = useState<TabWithPanes | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the load effect. Used to retry a failed load
  // when the tab is (re)activated — without it, one transient failure
  // (server blip, stale-cache race) left a kept-alive instance on a
  // permanent error screen that only a full page refresh could clear.
  const [loadNonce, setLoadNonce] = useState(0);
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;
  useEffect(() => {
    // Deliberately keyed on the activation transition only (not on
    // `error`) so a failure while already active can't retry-loop;
    // leaving and re-entering the tab is the retry gesture.
    if (isActive && errorRef.current) setLoadNonce((n) => n + 1);
  }, [isActive]);
  // Live mirror of isActive for async closures (the tab-load effect doesn't
  // re-run on activation, so its captured prop value can be stale).
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // True from the moment we know the tab is about to disappear (cascade
  // close, explicit close-tab CTA, …) until we actually navigate away.
  // Used to suppress the empty-tab state flicker that would otherwise
  // render for a frame between "last pane removed locally" and
  // "navigate to next route".
  const [closingTab, setClosingTab] = useState(false);
  const [mobileActiveId, setMobileActiveId] = useState<string | null>(null);
  const layoutRef = useRef<Layout>(null);
  // >0 while a local layout PATCH is in flight (a close, or an empty tab's
  // first chat).
  // The server-snapshot appliers (tab.updated, reconnect re-fetch) must NOT
  // overwrite layoutRef/panes during this window — a snapshot taken before our
  // patch landed reflects the PRE-change layout and would revert an
  // optimistic split ("flashes then nothing"). Our own patch echo (carrying
  // the new layout) reconciles once the window closes.
  const pendingLayoutWrites = useRef(0);
  // True when a tab.updated's layout was skipped mid-write — triggers a
  // refetch once writes settle (see persistLayout).
  const skippedTabUpdate = useRef(false);
  // Moves on every change that reaches this tab by a route other
  // than a detail GET — a pushed pane or tab event, or a local layout write. The reconnect resync captures it before fetching and
  // discards an answer it overtook (see fetchUnsuperseded): `pendingLayoutWrites`
  // only knows about OUR writes in flight, not about another client's pane that
  // already arrived by push while the GET was on the wire.
  const detailGeneration = useRef(0);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  // ONE THING ON SCREEN, on every device. Desktop's split mosaic and its pane
  // strip are gone: a tab holds one chat, agent or terminal, so the view that
  // phones were always forced into is the only view there is. The "active
  // pane" machinery below stays because an old row may still hold a stray
  // second pane, and it must land on one of them rather than on neither.
  // `mobileActiveId` is that active-pane state, on desktop too.

  // Remember which tab we're on so the next visit to /w/$wsSlug
  // restores it (see WorkspaceLayout). Gated on a successful load —
  // recording a slug that turns out not to exist would make the
  // workspace-root redirect bounce right back to the dead tab.
  useEffect(() => {
    if (!isActive || !tab) return;
    setLastTabSlug(wsSlug, tabSlug);
  }, [isActive, tab, wsSlug, tabSlug]);

  // Persist the active pane per tab whenever it changes.
  useEffect(() => {
    if (!tab || !mobileActiveId) return;
    setLastPaneId(tab.id, mobileActiveId);
  }, [tab, mobileActiveId]);

  // The active pane the URL names (`?pane=<id>`).
  const urlPane = useRouterState({
    select: (s) => (s.location.search as { pane?: string }).pane,
  });
  // The tab slug the URL is ACTUALLY on right now (straight from pathname, no
  // fallback). `isActive` can briefly lag the URL during a switch (it derives
  // from shownTabSlug, which falls back to the LAST tab when urlTabSlug is
  // momentarily null) — and a stale isActive would let this tab's ?pane-sync
  // fire mid-switch and navigate the URL back to itself, bouncing you home
  // instead of switching. Gating the sync on this exact match kills that race.
  const urlTabSlug = useRouterState({
    select: (s) => s.location.pathname.match(/\/t\/([^/?]+)/)?.[1] ?? null,
  });

  // Seed the active pane from the URL the first time this tab is active — a
  // refresh / shared link / back button lands on the pane
  // the URL names (priority over last-visited storage). Once set, mobileActiveId
  // is the source of truth and the URL just follows it (next effect).
  useEffect(() => {
    if (!isActive || !tab || mobileActiveId) return;
    if (urlPane && tab.panes.some((p) => p.id === urlPane)) setMobileActiveId(urlPane);
  }, [isActive, tab, urlPane, mobileActiveId]);

  // Stable inputs for the ?pane sync effect below. Derived in render off the
  // pane-id SET (not the whole `tab` object) so the effect DOESN'T re-fire on
  // every pane.updated churn — title/busy/attention updates give `tab` a new
  // reference constantly on a busy agent workspace, and re-running the sync each
  // time could land a stale replace() right as the user clicks a cross-tab /
  // cross-workspace link, bouncing them straight back ("navigation does
  // nothing"). The pane-id key changes only on real structural edits.
  const syncPaneIds = tab ? tab.panes.map((p) => p.id) : [];
  const syncPaneIdsKey = syncPaneIds.join(',');
  const syncActiveId = (() => {
    if (!tab) return null;
    const stored = getLastPaneId(tab.id);
    return (
      (mobileActiveId && syncPaneIds.includes(mobileActiveId) && mobileActiveId) ||
      (urlPane && syncPaneIds.includes(urlPane) && urlPane) ||
      (stored && syncPaneIds.includes(stored) && stored) ||
      syncPaneIds[0] ||
      null
    );
  })();

  // Keep `?pane` in step with the active pane — ONLY for the active tab, so
  // hidden TabViews never fight over the shared URL.
  // Resolution mirrors the render branches (state → a still-valid URL pane →
  // last-visited → first); honoring a valid urlPane before state catches up
  // stops the seed above from being clobbered on load. Replace, not push: it
  // reflects state, it isn't a history entry per pane tap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tab` is intentionally excluded (see syncPaneIdsKey above) — the id-set key + syncActiveId are the real triggers, not every pane.updated churn.
  useEffect(() => {
    // Only the tab the URL is actually on manages its ?pane — never a tab
    // that's merely still-isActive mid-switch (that's the bounce, see urlTabSlug).
    if (!isActive || !tab || urlTabSlug !== tabSlug) return;
    // Live re-check against the ACTUAL address bar: the urlTabSlug/isActive we
    // captured in this render can lag a cross-tab / cross-workspace navigation
    // the user JUST triggered, and a stale replace() here would clobber it and
    // bounce them back where they came from. Bail if the URL has already moved
    // off this tab. This is the belt to urlTabSlug's braces — a synchronous read
    // that can't be stale.
    const live = window.location.pathname.match(/^\/w\/([^/]+)\/t\/([^/?]+)/);
    const liveTab = live?.[2] ? decodeURIComponent(live[2]) : null;
    if (!live || live[1] !== wsSlug || liveTab !== tabSlug) return;
    if (!syncActiveId || syncActiveId === urlPane) return;
    navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug, tabSlug },
      search: (prev) => ({ ...prev, pane: syncActiveId }),
      replace: true,
    });
  }, [
    isActive,
    tab?.id,
    syncPaneIdsKey,
    syncActiveId,
    urlPane,
    urlTabSlug,
    navigate,
    wsSlug,
    tabSlug,
  ]);

  // Mobile pane slots stay mounted when hidden (scroll position preserved).
  // Focus the active pane's terminal when the active pane CHANGES (switch /
  // tab entry) — NOT on every render. `tab` gets a new reference on every
  // pane.updated (title/fg/attention/busy), and this effect deps on it; without
  // the guard, a churning pane re-dispatches focus-pane constantly, which steals
  // focus from the mobile composer the user is typing in (the terminal's helper
  // textarea has inputMode=none, so grabbing it dismisses the soft keyboard and
  // the input bar drops). Mirrors desktopFocusHandledRef below.
  const mobileFocusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tab || !isActive) {
      // Reset on deactivation so re-entering the tab refocuses its pane.
      if (!isActive) mobileFocusedRef.current = null;
      return;
    }
    const paneIds = collectPaneIds(toLayout(tab.layout));
    const stored = getLastPaneId(tab.id);
    const activeId =
      mobileActiveId && paneIds.includes(mobileActiveId)
        ? mobileActiveId
        : stored && paneIds.includes(stored)
          ? stored
          : (paneIds[0] ?? null);
    if (!activeId) return;
    // Already focused this pane → don't re-grab (would steal composer focus).
    if (mobileFocusedRef.current === activeId) return;
    mobileFocusedRef.current = activeId;
    window.dispatchEvent(new CustomEvent('muxpad:focus-pane', { detail: { paneId: activeId } }));
  }, [tab, mobileActiveId, isActive]);

  // Desktop: restore keyboard focus to the last-focused pane when this tab
  // becomes active again. Panes stay mounted across tab switches, so
  // XtermPane's mount-time autoFocus only fires on first visit — switching
  // back to an already-mounted tab needs an explicit re-focus. We track
  // "handled for this activation" rather than a bare false→true transition so
  // the focus still lands if the tab's data finishes loading a beat after it
  // became active (the source of the "doesn't happen all the time" flakiness).
  const desktopFocusHandledRef = useRef(false);
  useEffect(() => {
    if (!isActive) {
      desktopFocusHandledRef.current = false;
      return;
    }
    if (isMobile || !tab || desktopFocusHandledRef.current) return;
    const paneIds = collectPaneIds(toLayout(tab.layout));
    const stored = getLastPaneId(tab.id);
    const target = stored && paneIds.includes(stored) ? stored : (paneIds[0] ?? null);
    if (!target) return; // panes not ready yet; a later render retries
    desktopFocusHandledRef.current = true;
    // Defer a frame so the tab's container has flipped from hidden to visible
    // — term.focus() on a still-`display:none` element doesn't stick.
    const raf = requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('muxpad:focus-pane', { detail: { paneId: target } }));
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, isMobile, tab]);

  // Pane selection from OUTSIDE the pane views (the mobile sheet's pane
  // rows). A mounted TabView switches immediately; an unmounted one reads
  // the sheet's setLastPaneId on mount instead.
  useEffect(() => {
    const onSelectPane = (e: Event) => {
      const d = (e as CustomEvent<{ tabId?: string; paneId?: string }>).detail;
      if (d?.tabId === tab?.id && d.paneId) setMobileActiveId(d.paneId);
    };
    window.addEventListener('muxpad:select-pane', onSelectPane);
    return () => window.removeEventListener('muxpad:select-pane', onSelectPane);
  }, [tab?.id]);

  // Push-notification deep link: a tap targets a specific PANE, and the SW
  // message handler (main.tsx) broadcasts muxpad:show-pane after routing to
  // the owning tab. Every mounted TabView hears it; only the one that owns
  // the pane reacts, by making it the one on screen.
  useEffect(() => {
    const onShowPane = (e: Event) => {
      const paneId = (e as CustomEvent<{ paneId?: string }>).detail?.paneId;
      if (!paneId || !tab) return;
      if (!collectPaneIds(toLayout(tab.layout)).includes(paneId)) return;
      setMobileActiveId(paneId);
    };
    window.addEventListener('muxpad:show-pane', onShowPane);
    return () => window.removeEventListener('muxpad:show-pane', onShowPane);
  }, [tab]);

  // Deterministic backstop for the above: a push tap stashes its target pane in
  // a module store; consume it here whenever THIS tab renders/activates. Covers
  // the show-pane event firing before this TabView existed (late cross-workspace
  // mount) — it consumes exactly once, and setting the active pane on a not-yet-
  // visible tab is fine (it shows the pane when it becomes active).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `isActive` is an intentional re-run trigger (consume on activation), not read in the body.
  useEffect(() => {
    if (!tab) return;
    const forced = consumePushFocusPane(tab.id);
    if (forced && tab.panes.some((p) => p.id === forced)) setMobileActiveId(forced);
  }, [tab, isActive]);

  // Persist the active pane on every focus event from any XtermPane
  // in the current tab. Desktop has no "active pane" in component
  // state — focus lives entirely in the DOM — so we record it here so
  // a page refresh can restore the right pane via getLastPaneId below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tab?.panes` is narrower than `tab` deliberately: this subscribes a window listener, and re-subscribing on every poll-replaced tab object is pure churn
  useEffect(() => {
    if (!tab) return;
    const tabId = tab.id;
    const ids = new Set(tab.panes.map((p) => p.id));
    const onFocused = (e: Event) => {
      const detail = (e as CustomEvent<{ paneId?: string }>).detail;
      if (detail?.paneId && ids.has(detail.paneId)) {
        setLastPaneId(tabId, detail.paneId);
      }
    };
    window.addEventListener('muxpad:pane-focused', onFocused);
    return () => window.removeEventListener('muxpad:pane-focused', onFocused);
  }, [tab?.id, tab?.panes]);

  // Surgical mark-seen: only the pane on screen, so a stray hidden sibling on
  // an old row keeps its flag (see seen-ack.ts). Fires on tab mount and on any
  // pane switch. Refreshes workspaces/tabs so the favicon
  // + chrome dots update without waiting for the 5s poll.
  //
  // The active pane resolves through the same fallback chain the render branch uses (state → last-visited storage →
  // first pane). Without this, the implicit-active pane on a fresh tab mount
  // (mobileActiveId still null) would never get mark-seen until the
  // user explicitly tapped it — leaving the attention dot stuck.
  const mobileActiveResolved = (() => {
    if (!tab) return null;
    const ids = tab.panes.map((p) => p.id);
    if (mobileActiveId && ids.includes(mobileActiveId)) return mobileActiveId;
    const stored = getLastPaneId(tab.id);
    if (stored && ids.includes(stored)) return stored;
    return ids[0] ?? null;
  })();
  // D11: the dot didn't clear on the tab you were ALREADY watching. This effect
  // ran on mount, pane-switch and unmount, and none of its deps changed when a
  // BEL rang (or a turn finished) while you sat there — so the sidebar kept
  // flagging a tab that was open on your screen, and the comment in NavTree
  // claiming "the dot still self-hides on the active tab via markSeen" was
  // simply false.
  //
  // The fix is a dep that moves on those edges: a signature of the panes'
  // read-state. It terminates — mark-seen makes the server emit pane.updated
  // with the flags cleared, which changes the signature once more, and the
  // follow-up call finds nothing left to clear (both /seen routes only emit
  // when something actually changed), so the third pass never happens.
  const seenSignature = (tab?.panes ?? [])
    .map((p) => `${p.id}:${p.attention === true ? 1 : 0}${p.unread === true ? 1 : 0}`)
    .join('|');
  // Selected is not seen: a backgrounded browser keeps this tab `isActive`,
  // and acking there cleared unread marks on every device for replies nobody
  // displayed. Gated on visibility here and rechecked when the debounce fires;
  // the flip back to visible re-runs the effect and acks what piled up.
  const docVisible = useDocumentVisible();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seenSignature` is the load-bearing dep and biome calls it unnecessary. It is not: it moves on exactly the read-state edges (D11) that `tab` identity cannot express, and depending on `tab` instead would re-ack on every poll
  useEffect(() => {
    if (!tab || !workspace || !isActive || !docVisible) return;
    // Debounced. `attention` is the BEL bit, and a pane can ring it in a tight
    // loop (shell completion beeps, a chatty build) — each ring moves the
    // signature, and each run costs a POST plus two list refetches. Coalescing
    // a storm into one round trip is free; the delay is imperceptible for
    // something whose whole job is to clear a dot on the tab you're watching.
    const t = window.setTimeout(() => {
      if (!documentVisible()) return;
      const refresh = () =>
        Promise.all([refreshTabs(workspace.id), refreshWorkspaces()]).catch(() => {});
      const ack = seenAckTarget({
        singlePane: true,
        activePaneId: mobileActiveResolved,
        tabId: tab.id,
      });
      if (!ack) return;
      (ack.kind === 'pane' ? api.markPaneSeen(ack.id) : api.markTabSeen(ack.id))
        .then(refresh)
        .catch(() => {});
    }, 300);
    return () => window.clearTimeout(t);
  }, [tab?.id, mobileActiveResolved, workspace?.id, isActive, docVisible, seenSignature]);

  // Title pulls the live name from the shared tabs list so renames in
  // the tab bar update the document title without a refetch here. The
  // hidden system workspace's internal name ("· system ·") never surfaces —
  // its one tab is the resident "muxpad" agent, so the title is the plain
  // brand.
  const liveName = allTabs.find((t) => t.slug === tabSlug)?.name ?? tab?.name;
  const liveWorkspaceName = workspace?.name;
  const documentTitle = workspace?.hidden
    ? 'muxpad'
    : liveWorkspaceName && liveName
      ? `${liveWorkspaceName} ⋅ ${liveName}`
      : (liveName ?? liveWorkspaceName ?? 'muxpad');

  // The braille document-title spinner is gone, deliberately. It duplicated a
  // signal you can already see — the status rail says "working" in the
  // navigator, in the tab strip and in the mobile switcher — and it rode the
  // exact same broken input: `tab.panes[].busy`, which a PATCH-route
  // pane.updated blanked on every face switch (D1). A duplicate indicator that
  // is wrong in the same cases as the original buys nothing and costs a
  // 120ms interval rewriting document.title for the lifetime of every turn.
  useEffect(() => {
    if (!isActive) return;
    const previous = document.title;
    document.title = documentTitle;
    return () => {
      document.title = previous;
    };
  }, [isActive, documentTitle]);

  // Keep local tab.name in sync with the shared list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs off `allTabs`; `tab.name` is the value being COMPARED against, and listing it would re-run the effect with the answer it just wrote
  useEffect(() => {
    if (!tab) return;
    const updated = allTabs.find((t) => t.id === tab.id);
    if (updated && updated.name !== tab.name) {
      setTab((prev) => (prev ? { ...prev, name: updated.name } : prev));
    }
  }, [allTabs, tab?.id]);

  // Load this tab once when the TabView instance mounts. Each workspace
  // tab gets its own instance (kept alive while hidden) so switching
  // tabs does not tear down xterm panes. Title / fg / attention and
  // structural changes arrive via /ws/events after the initial load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `workspace?.id`: `navigate` and the workspace object are both recreated per render, and re-running this recovery on either would fight the navigation it performs
  useEffect(() => {
    void loadNonce; // dep is the retry trigger; no value needed in the body
    if (!workspace) return;
    setClosingTab(false);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        // Go through the shared cache, not a raw api.listTabs(): this effect
        // runs one mount-tick after useTabs() above already fetched the very
        // same list, so a direct call was a guaranteed duplicate GET on every
        // cold load. freshTabs() joins that request (or reuses its result if
        // it just landed) and refetches otherwise.
        const tabs = await freshTabs(workspace.id);
        const found = tabs.find((t) => t.slug === tabSlug);
        if (!found) {
          // The shared tabs cache said this slug exists but the fresh list
          // disagrees — the tab was deleted out from under us (another
          // device, server-side cascade). Don't dead-end on an error
          // screen; bounce to the workspace root, whose redirect effect
          // picks a valid tab. Refresh the shared caches FIRST so that
          // redirect can't pick this same dead slug out of the stale
          // list and bounce straight back here. Only the active view
          // navigates — a hidden TabView yanking the router out from
          // under the visible one would be worse than its silent stale
          // state.
          setError('tab not found');
          await Promise.all([refreshTabs(workspace.id), refreshWorkspaces()]).catch(() => {});
          if (cancelled) return;
          if (isActiveRef.current) {
            void navigate({ to: '/w/$wsSlug', params: { wsSlug }, replace: true });
          }
          return;
        }
        // Fenced like the resync below. On a RELOAD (loadNonce — most often
        // persistLayout's refetch after it skipped a concurrent tab.updated)
        // the subscription is live, so a pane.added / tab.updated landing
        // while this GET is on the wire is applied first and would then be
        // rolled back by the older answer. Null = every answer was overtaken
        // and the held tab is newer; only possible once a tab is held, since
        // nothing moves the generation before then.
        const detail = await fetchUnsuperseded(
          () => api.getTab(found.id),
          () => detailGeneration.current,
        );
        if (cancelled) return;
        if (detail) {
          setTab(detail);
          layoutRef.current = toLayout(detail.layout);
        }
        // Mark-seen on mount is deliberately NOT done here anymore — a
        // bulk tab-seen on mount would clear every pane's attention
        // before the user could see which pane was BELing in the nav
        // sheet's pane list. The per-pane / per-mode seen happens
        // in the dedicated visibility-gated effect. Cleanup must not ack:
        // it also runs on reloads and for panes nobody ever displayed.
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, tabSlug, loadNonce]);

  const persistLayout = useCallback(
    async (layout: Layout) => {
      if (!tab) return;
      pendingLayoutWrites.current += 1;
      detailGeneration.current += 1;
      try {
        // SERIALIZED PER TAB. A whole-layout PATCH is last-writer-wins, so two
        // rapid structural edits (a close, then a first chat) racing could
        // land B before A — and A, written last, describes a tree that predates
        // B's newly created pane. The pane row survives but no layout mentions
        // it, and the settle-refetch faithfully adopts that wrong truth. The
        // chain makes the wire order match the user's order; it does not make
        // the write conditional, so a SECOND writer (another device) can still
        // win last — that's the same last-writer-wins the endpoint has always
        // had, and out of scope for a client-side fix.
        await enqueueLayoutWrite(tab.id, () =>
          api.patchTab(tab.id, { layout: fromLayout(layout) }),
        );
      } catch (e) {
        console.error('failed to persist layout', e);
      } finally {
        pendingLayoutWrites.current -= 1;
        // A tab.updated arrived while we were writing and its layout was
        // skipped (it may have carried a concurrent merge/move into this
        // tab). Our own optimistic layout can't know about those panes, so
        // refetch the server's truth now that the write settled.
        if (pendingLayoutWrites.current === 0 && skippedTabUpdate.current) {
          skippedTabUpdate.current = false;
          setLoadNonce((n) => n + 1);
        }
      }
    },
    [tab],
  );

  const notifyLayoutChanged = useCallback(() => {
    const fire = () => window.dispatchEvent(new Event('muxpad:layout-changed'));
    fire();
    requestAnimationFrame(fire);
    window.setTimeout(fire, 200);
    window.setTimeout(fire, 500);
  }, []);

  /**
   * Delete the current tab. Used both by the explicit "close this tab"
   * link and by removePaneFromLayout when the last pane is gone (full
   * cascade: close-pane → close-tab → close-workspace).
   *
   * If this was the last tab in the workspace, navigate to the workspace
   * root (`/w/$wsSlug`). WorkspaceLayout there renders an empty-state UI
   * with "+ New tab" and "or close this workspace" affordances — the user
   * decides whether to populate or delete. Workspaces never disappear
   * implicitly anymore.
   */
  const closeTab = useCallback(async () => {
    if (!tab || !workspace) return;
    setClosingTab(true);
    // Snapshot allTabs BEFORE the delete so neighbor selection is
    // deterministic — otherwise a background poll could refresh the
    // cache mid-flight and remove our row, leaving findIndex === -1
    // and jumping the user to the leftmost tab instead of the
    // closed tab's neighbor.
    const beforeTabs = allTabs;
    const myIdx = beforeTabs.findIndex((t) => t.id === tab.id);
    const isLastTab = beforeTabs.length <= 1;
    try {
      await api.deleteTab(tab.id);
    } catch (err) {
      console.error('close tab failed', err);
      setClosingTab(false);
      return;
    }
    if (isLastTab) {
      // Refresh BOTH caches before navigating: tabs so WorkspaceLayout's
      // redirect-to-first-tab effect sees an empty list (otherwise it
      // bounces us right back to the just-deleted tab), and workspaces
      // so the empty-state UI's `workspace.tab_count === 0` gate flips.
      // replace: true keeps the deleted tab out of browser history.
      await Promise.all([refreshTabs(workspace.id), refreshWorkspaces()]);
      void navigate({ to: '/w/$wsSlug', params: { wsSlug }, replace: true });
      return;
    }
    // Pick the neighbor: right if there is one, else left. Matches
    // the convention browsers use when closing the active tab.
    const next = beforeTabs[myIdx + 1] ?? beforeTabs[myIdx - 1];
    await refreshTabs(workspace.id);
    await refreshWorkspaces();
    if (!next) {
      // Shouldn't happen (we already handled isLastTab above), but be
      // defensive: if there's no neighbor, fall back to workspace root.
      void navigate({ to: '/w/$wsSlug', params: { wsSlug } });
      return;
    }
    void navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug, tabSlug: next.slug },
    });
  }, [tab, workspace, allTabs, navigate, wsSlug]);

  const removePaneFromLayout = useCallback(
    async (paneId: string) => {
      const newLayout = removePane(layoutRef.current, paneId);
      // If this was the last pane, mark the tab as closing BEFORE we
      // setTab() so the next render doesn't briefly show the empty-tab
      // CTA before closeTab navigates away.
      if (newLayout == null || newLayout === '') {
        setClosingTab(true);
      }
      layoutRef.current = newLayout;
      setTab((prev) =>
        prev
          ? {
              ...prev,
              layout: fromLayout(newLayout),
              panes: prev.panes.filter((p) => p.id !== paneId),
            }
          : prev,
      );
      try {
        await api.deletePane(paneId);
      } catch (err) {
        console.error('failed to delete pane', err);
      }
      await persistLayout(newLayout);
      notifyLayoutChanged();
      const remaining = collectPaneIds(newLayout);
      if (remaining.length > 0) {
        const next = remaining[0]!;
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('muxpad:focus-pane', { detail: { paneId: next } }));
        }, 0);
      } else {
        // Last pane in this tab is gone → cascade-close the tab.
        // If this was also the workspace's last tab, closeTab navigates
        // to /w/$wsSlug where WorkspaceLayout renders the empty-state
        // UI (+ New tab / Close workspace). Workspaces never auto-delete.
        void closeTab();
      }
    },
    [persistLayout, notifyLayoutChanged, closeTab],
  );

  /**
   * An EMPTY tab's way back to holding something — the one place this view
   * creates a row. Placed by the server (`append_to_layout`), which accepts it
   * only because the tab holds nothing yet: every other "add a second thing
   * here" is refused there, not merely missing here.
   */
  const startChat = useCallback(async () => {
    if (!tab) return;
    try {
      const created = await api.createPane(tab.id, {
        append_to_layout: true,
        ...HOUSE_CHAT_PANE_CREATE,
      });
      layoutRef.current = created.id;
      setLastPaneId(tab.id, created.id);
      setTab((prev) =>
        prev
          ? {
              ...prev,
              layout: created.id,
              // The pane.added event may have landed first (same id).
              panes: prev.panes.some((p) => p.id === created.id)
                ? prev.panes
                : [...prev.panes, created],
            }
          : prev,
      );
      notifyLayoutChanged();
    } catch (err) {
      console.error('start chat failed', err);
    }
  }, [tab, notifyLayoutChanged]);

  const onPaneExited = useCallback(
    (paneId: string) => {
      void removePaneFromLayout(paneId);
    },
    [removePaneFromLayout],
  );

  // Subscribe to server-pushed events for the currently-viewed tab.
  // This is the ONLY source of structural updates after the initial load
  // — there's no 5s poll fallback anymore.
  //
  // MUST live before the early-return below; same rules-of-hooks issue
  // we fixed in commit 8937e0e for the (since removed) onKindToggled.
  //
  // The `tab` closure may go stale when the user navigates to a
  // different tab, but `tab?.id` is in the dep array so the effect
  // re-subscribes on tab change. We still filter on `e.tab_id ===
  // tab.id` defensively in case any in-flight events slip through.
  //
  // pane.updated merges rather than overwrites (mergePaneUpdated): a
  // payload that OMITS a runtime decoration keeps the old value, while an
  // explicit null — the server saying the runtime is gone — clears it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `tab?.id` on purpose: the tab OBJECT is replaced by every poll, so depending on it would re-run this on a timer rather than when the tab actually changes
  useEffect(() => {
    if (!tab) return;
    const tabId = tab.id;
    return subscribe((e) => {
      if (e.type === 'pane.added' && e.tab_id === tabId) {
        detailGeneration.current += 1;
        setTab((prev) =>
          prev && !prev.panes.some((p) => p.id === e.pane.id)
            ? { ...prev, panes: [...prev.panes, e.pane] }
            : prev,
        );
      } else if (e.type === 'pane.removed' && e.tab_id === tabId) {
        detailGeneration.current += 1;
        setTab((prev) =>
          prev ? { ...prev, panes: prev.panes.filter((p) => p.id !== e.pane_id) } : prev,
        );
      } else if (e.type === 'pane.updated' && e.tab_id === tabId) {
        // Detail snapshots carry decorations too; an older GET must not revive
        // a cleared title or roll back the live status/unread value.
        detailGeneration.current += 1;
        setTab((prev) =>
          prev
            ? {
                ...prev,
                panes: prev.panes.map((p) =>
                  p.id === e.pane.id ? mergePaneUpdated(p, e.pane) : p,
                ),
              }
            : prev,
        );
      } else if (e.type === 'tab.updated' && e.tab.id === tabId) {
        detailGeneration.current += 1;
        // Skip the layout if we have a local layout write in flight — this
        // snapshot may predate it and would revert an optimistic split. But
        // REMEMBER the skip: the frame may also carry someone else's change
        // (a merge landing panes into this tab), and dropping it silently
        // would leave those panes in state but never in the mosaic. When the
        // write settles, persistLayout refetches the server truth.
        const applyLayout = pendingLayoutWrites.current === 0;
        if (!applyLayout) skippedTabUpdate.current = true;
        setTab((prev) => (prev ? applyTabUpdated(prev, e.tab, applyLayout) : prev));
        if (applyLayout) layoutRef.current = toLayout(e.tab.layout);
      } else if (e.type === 'tab.removed' && e.tab_id === tabId) {
        setClosingTab(true);
        // Only the ACTIVE tab's removal should redirect. A hidden tab being
        // removed — closed from the sidebar, or relocated to another
        // workspace (tab.removed now doubles as "moved away") — must not yank
        // the user off the tab they're actually viewing. (last-visited used to
        // paper over this with a redirect bounce; the guard makes it clean.)
        if (isActiveRef.current) {
          // A gather gesture (merge / last-pane move) that dissolved THIS tab
          // recorded where its panes went — follow them there instead of
          // dumping the user on the workspace root.
          const follow = consumeFollowTarget(tabId);
          if (follow) {
            void navigate({
              to: '/w/$wsSlug/t/$tabSlug',
              params: { wsSlug: follow.wsSlug, tabSlug: follow.tabSlug },
            });
          } else {
            void navigate({ to: '/w/$wsSlug', params: { wsSlug } });
          }
        }
      }
    });
  }, [tab?.id, navigate, wsSlug]);

  // Re-fetch the active tab's detail whenever the events socket
  // (re)connects AND when the document becomes visible. Any
  // pane.added/removed/updated emitted during a disconnect window was
  // lost, and iOS can kill a backgrounded events socket without firing
  // close — so subscribeReconnect never runs. Visibility is the HTTP
  // backstop; the sidebar already refetches this way, the mosaic did not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `tab?.id` on purpose — see the other effects in this file; the object identity churns on every refresh and the id is what actually identifies the tab
  useEffect(() => {
    if (!tab) return;
    const tabId = tab.id;
    return subscribeResync(() => {
      // Superseded answers are thrown away, not merged: a GET that left before
      // another client's pane.added(Q) + tab.updated(P|Q) reached us answers
      // with P alone, and installing it removed Q from state AND the mosaic —
      // for good, since pane.updated only maps panes already held and nothing
      // else re-adds one. Null = every answer was overtaken; what the events
      // delivered is newer than all of them, so keep it.
      void fetchUnsuperseded(
        () => api.getTab(tabId),
        () => detailGeneration.current,
      )
        .then((detail) => {
          if (!detail) return;
          // If a local layout write is in flight, this snapshot may predate it
          // — keep our optimistic layout + panes (the just-split pane isn't in
          // the server's copy yet) and take only the rest.
          const applyLayout = pendingLayoutWrites.current === 0;
          setTab((prev) => {
            if (!prev || prev.id !== tabId) return prev;
            if (applyLayout) return { ...prev, ...detail };
            const { layout: _layout, panes: _panes, ...rest } = detail;
            return { ...prev, ...rest };
          });
          if (applyLayout) layoutRef.current = toLayout(detail.layout);
        })
        .catch(() => {
          // Tab may have been deleted during the disconnect window — the
          // subscribe() effect's tab.removed handler is the safety net for
          // that path. Swallow here.
        });
    });
  }, [tab?.id]);

  if (error && isActive)
    return (
      <div className="workspace-error">
        <p>{error}</p>
      </div>
    );
  if (!tab) return isActive ? <div className="workspace-loading">loading…</div> : null;
  // While the cascade-close is in flight, render nothing instead of the
  // empty-tab CTA. The closeTab nav fires shortly after; this avoids a
  // brief flicker between "last pane gone" and "route changes".
  if (closingTab) return isActive ? <div className="workspace-loading">loading…</div> : null;

  const layout = layoutRef.current;
  const isEmpty = layout == null || layout === '';

  const paneLabel = (paneId: string): string => {
    const p = tab.panes.find((x) => x.id === paneId);
    // A user-set name wins over everything — that's the whole point of the
    // rename: claude/the shell can rewrite the terminal title all it likes,
    // but the pinned name is what shows until the user clears it.
    const custom = p?.name?.trim();
    if (custom) return custom;
    if (p?.kind === 'url' && p.url) {
      try {
        return new URL(p.url).hostname;
      } catch {
        return p.url;
      }
    }
    const title = p?.title?.trim();
    if (title) return title;
    const cmd = p?.foreground_cmd?.trim();
    if (cmd) return cmd;
    return rowNounTitle(p);
  };

  if (isEmpty) {
    // A tab with nothing in it — the 2 empty rows on the live install, or one
    // whose last thing just went. It offers the two ways out: give it a chat,
    // or let it go.
    return (
      <div className="workspace-root">
        <main className="workspace-body">
          <div className="workspace-empty">
            <p>Nothing is open here.</p>
            <button type="button" className="btn btn-primary" onClick={() => void startChat()}>
              Start a chat
            </button>
            <button type="button" className="workspace-empty-close" onClick={() => void closeTab()}>
              or close this tab
            </button>
          </div>
        </main>
      </div>
    );
  }

  // Fallback chain: in-memory state → persisted last pane for this tab →
  // first pane. Lets a workspace/tab switch land back on the pane the user was
  // last looking at, not always paneIds[0].
  const paneIds = collectPaneIds(layout);
  const stored = getLastPaneId(tab.id);
  const activeId =
    mobileActiveId && paneIds.includes(mobileActiveId)
      ? mobileActiveId
      : stored && paneIds.includes(stored)
        ? stored
        : (paneIds[0] ?? null);
  const activePane = activeId ? tab.panes.find((p) => p.id === activeId) : undefined;

  // The mobile top bar carries the one control a terminal still needs: its
  // face switch (terminal ⇄ the web app it serves). A chat has nothing to put
  // there, so it paints no bar at all. Portalled up because the top bar
  // (AppLayout) has no pane context; gated on isActive so kept-mounted hidden
  // tabs don't paint duplicates. The shared rule, not a hand-rolled copy of
  // half of it: a pane CONVERTED to chat is as much an agent as one launched
  // as a chat.
  const webSwitch =
    isMobile &&
    isActive &&
    activePane &&
    activePane.kind === 'shell' &&
    !isAgentPane(activePane) ? (
      <PaneWebSwitch
        paneId={activePane.id}
        appUrls={activePane.app_urls ?? []}
        startupCmd={activePane.startup_cmd}
      />
    ) : null;

  return (
    <div className={isMobile ? 'workspace-root workspace-mobile' : 'workspace-root'}>
      {webSwitch ? (
        <MobilePaneChrome>
          <div className="mobile-strip-webswitch">{webSwitch}</div>
        </MobilePaneChrome>
      ) : null}
      <main className={isMobile ? 'workspace-body workspace-body-mobile' : 'workspace-body'}>
        {/* Bodies in a STABLE order (sorted pane id). Only one slot is
            visible, so DOM order is invisible — but a body that moved in the
            DOM would reload its xterm/iframe and refit it to a transient width.
            The order a stray sibling arrives in must not be able to do that. */}
        {[...paneIds].sort().map((paneId) => {
          const pane = tab.panes.find((p) => p.id === paneId);
          if (!pane) return null;
          const paneIsActive = paneId === activeId;
          return (
            <div
              key={paneId}
              className={isMobile ? 'mobile-pane-slot' : 'tabbed-pane-slot'}
              hidden={!paneIsActive}
              aria-hidden={!paneIsActive}
            >
              <PaneBody
                pane={pane}
                onExit={() => onPaneExited(paneId)}
                autoFocus={paneIsActive}
                paneActive={isActive && paneIsActive}
              />
            </div>
          );
        })}
      </main>
      {isMobile ? (
        <MobileInputBar
          paneId={activeId}
          paneKind={activePane?.kind ?? null}
          foregroundCmd={activePane?.foreground_cmd ?? null}
        />
      ) : (
        <ExternalOpenToasts
          currentTabId={tab.id}
          // Return null for ids that aren't in this tab's pane list so the
          // toast can show its generic "Something in this tab requested..."
          // fallback instead of paneLabel's "Terminal"-style one (which would
          // name a thing this tab does not hold).
          paneLabel={(id) => (tab.panes.some((p) => p.id === id) ? paneLabel(id) : null)}
        />
      )}
    </div>
  );
}

/**
 * Renders the body of a pane based on its `kind`. URL panes get
 * `<UrlPane>` (iframe); shell panes get `<XtermPane>` (terminal).
 */
function PaneBody({
  pane,
  onExit,
  autoFocus,
  paneActive = true,
}: {
  pane: PaneSpec;
  onExit: () => void;
  autoFocus?: boolean;
  paneActive?: boolean;
}) {
  if (pane.kind === 'url') {
    return <UrlPane paneId={pane.id} url={pane.url} />;
  }
  return (
    <ShellPaneBody pane={pane} onExit={onExit} autoFocus={autoFocus} paneActive={paneActive} />
  );
}
