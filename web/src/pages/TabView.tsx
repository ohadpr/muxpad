import { useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import type { DragEvent as ReactDragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Mosaic,
  type MosaicDirection,
  type MosaicNode,
  MosaicWindow,
} from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import type { AppUrl, LayoutNode, PaneSpec, Tab } from '@muxpad/shared';
import { collectLayoutLeaves, spliceLayoutAtTarget } from '@muxpad/shared';
import { type TabWithPanes, api } from '../api';
import { ExternalOpenToasts } from '../components/ExternalOpenToasts';
import { MobileInputBar } from '../components/MobileInputBar';
import { NewTabButton } from '../components/NewTabButton';
import {
  PaneFaceMenuList,
  PaneWebSwitch,
  SvgAgentGlyph,
  clampMenuLeft,
} from '../components/PaneWebSwitch';
// PaneSurfaceSwitch (below) reuses the .pane-web-switch-* menu classes, so
// depend on that stylesheet explicitly rather than relying on the mobile
// PaneWebSwitch mount to pull it into the bundle.
import '../components/PaneWebSwitch.css';
import { ShellPaneBody } from '../components/ShellPaneBody';
import { StatusMark } from '../components/StatusMark';
import { UrlPane } from '../components/UrlPane';
import { SvgClose } from '../components/icons';
import { subscribe, subscribeReconnect } from '../events';
import { HOUSE_CHAT_PANE_CREATE } from '../lib/agent-backend';
import { consumeFollowTarget } from '../lib/follow-tab';
import { getLastPaneId, setLastPaneId, setLastTabSlug } from '../lib/last-visited';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import { pushUndo } from '../lib/move-undo-store';
import { PANE_DRAG_MIME, paneDragOrigin } from '../lib/pane-drag';
import { usePaneFace } from '../lib/pane-face';
import { consumePushFocusPane } from '../lib/push-focus';
import { setTabViewMode, useTabViewMode } from '../lib/tab-view-mode';
import { useDismissable } from '../lib/use-dismissable';
import { freshTabs, refreshTabs, useTabs } from '../tabs';
import { useMediaQuery } from '../use-media-query';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';

// All "+" creates open the harness picker (agents + terminal + web view).

import './tab.css';

type Layout = MosaicNode<string> | null;

function toMosaic(layout: LayoutNode): Layout {
  if (typeof layout === 'string') return layout || null;
  const node: MosaicNode<string> = {
    direction: layout.direction === 'row' ? 'row' : 'column',
    first: toMosaic(layout.first) ?? '',
    second: toMosaic(layout.second) ?? '',
  };
  if (layout.splitPercentage !== undefined) {
    (node as { splitPercentage?: number }).splitPercentage = layout.splitPercentage;
  }
  return node;
}

function fromMosaic(layout: Layout): LayoutNode {
  if (layout == null) return '';
  if (typeof layout === 'string') return layout;
  return {
    direction: layout.direction === 'row' ? 'row' : 'column',
    ...(layout.splitPercentage !== undefined ? { splitPercentage: layout.splitPercentage } : {}),
    first: fromMosaic(layout.first),
    second: fromMosaic(layout.second),
  };
}

/**
 * Replace `targetId` in the tree with a split. Returns the layout
 * unchanged if `targetId` isn't anywhere in the tree — the UI knows
 * which pane the user clicked, so a miss means a real bug (no
 * "fall back to root-append" rescue like the server's CLI path does).
 *
 * Wraps the shared `spliceLayoutAtTarget` helper, converting between
 * the Mosaic `Layout` type (null for empty) and the wire `LayoutNode`
 * type ('' for empty).
 */
function splitAtPane(
  layout: Layout,
  targetId: string,
  newId: string,
  direction: MosaicDirection,
): Layout {
  const { layout: next, placed } = spliceLayoutAtTarget(
    fromMosaic(layout),
    targetId,
    newId,
    direction,
  );
  return placed ? toMosaic(next) : layout;
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

/**
 * Rebuild a layout tree from an ordered list of pane ids as a balanced row.
 * Used when the user drags to reorder pane headers in the tab strip: the
 * strip order is derived from `collectPaneIds` (in-order traversal), so to
 * persist a new order we regenerate the tree. This deliberately discards the
 * previous split geometry/percentages — reordering tabs is a tabbed-mode
 * gesture, and losing the bsplit arrangement on the flip is acceptable (a
 * balanced row is a sane default when you next open split view). Balanced
 * (not right-leaning) so a subsequent split view shows even-ish columns.
 */
function buildRowLayout(ids: string[]): Layout {
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0] ?? null;
  const mid = Math.ceil(ids.length / 2);
  const first = buildRowLayout(ids.slice(0, mid));
  const second = buildRowLayout(ids.slice(mid));
  if (first == null) return second;
  if (second == null) return first;
  return { direction: 'row', first, second };
}

export interface TabViewProps {
  /** Stable slug for this instance — one TabView per tab in WorkspaceLayout. */
  tabSlug: string;
  /** False while the tab is mounted but hidden during a tab switch. */
  isActive: boolean;
}

/**
 * Paints the active tab's pane-level controls (face switch + new-pane +) into
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
  // Inline rename of a pane's tab-strip header (desktop 'tabbed' mode).
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null);
  const [paneDraft, setPaneDraft] = useState('');
  const paneEditRef = useRef<HTMLInputElement | null>(null);
  // Drag-to-reorder pane headers within the strip.
  const [paneDragId, setPaneDragId] = useState<string | null>(null);
  const [paneDropTargetId, setPaneDropTargetId] = useState<string | null>(null);
  const [paneDropSide, setPaneDropSide] = useState<'before' | 'after'>('before');
  const layoutRef = useRef<Layout>(null);
  // >0 while a local layout PATCH is in flight (split / drag-resize / close).
  // The server-snapshot appliers (tab.updated, reconnect re-fetch) must NOT
  // overwrite layoutRef/panes during this window — a snapshot taken before our
  // patch landed reflects the PRE-change layout and would revert an
  // optimistic split ("flashes then nothing"). Our own patch echo (carrying
  // the new layout) reconciles once the window closes.
  const pendingLayoutWrites = useRef(0);
  // True when a tab.updated's layout was skipped mid-write — triggers a
  // refetch once writes settle (see persistLayout).
  const skippedTabUpdate = useRef(false);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  // Desktop 'tabbed' mode renders the same single-pane-at-a-time UI mobile is
  // forced into, so both share the "active pane" machinery below via
  // `singlePane`. `mobileActiveId` is the shared active-pane state for both.
  const viewMode = useTabViewMode(tab?.id ?? null, tab?.view_mode);
  const singlePane = isMobile || viewMode === 'tabbed';
  // Holds the latest `addPane` function from the mobile render branch so
  // the top-level event listener below can reach it. The mobile chrome's
  // "+" button dispatches muxpad:add-pane (it lives in TabBar, outside
  // TabView's tree, so we can't pass an onAdd callback down directly).
  const addPaneRef = useRef<(() => void) | null>(null);

  // Remember which tab we're on so the next visit to /w/$wsSlug
  // restores it (see WorkspaceLayout). Gated on a successful load —
  // recording a slug that turns out not to exist would make the
  // workspace-root redirect bounce right back to the dead tab.
  useEffect(() => {
    if (!isActive || !tab) return;
    setLastTabSlug(wsSlug, tabSlug);
  }, [isActive, tab, wsSlug, tabSlug]);

  // Persist the active pane per tab whenever it changes (single-pane views
  // only — the split mosaic shows every pane at once, so has no "active" one).
  useEffect(() => {
    if (!singlePane || !tab || !mobileActiveId) return;
    setLastPaneId(tab.id, mobileActiveId);
  }, [singlePane, tab, mobileActiveId]);

  // The active pane the URL names (`?pane=<id>`). Reflected only in single-pane
  // modes; split ignores it.
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

  // Seed the active pane from the URL the first time this tab is active in a
  // single-pane view — a refresh / shared link / back button lands on the pane
  // the URL names (priority over last-visited storage). Once set, mobileActiveId
  // is the source of truth and the URL just follows it (next effect).
  useEffect(() => {
    if (!isActive || !singlePane || !tab || mobileActiveId) return;
    if (urlPane && tab.panes.some((p) => p.id === urlPane)) setMobileActiveId(urlPane);
  }, [isActive, singlePane, tab, urlPane, mobileActiveId]);

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
    if (!tab || !singlePane) return null;
    const stored = getLastPaneId(tab.id);
    return (
      (mobileActiveId && syncPaneIds.includes(mobileActiveId) && mobileActiveId) ||
      (urlPane && syncPaneIds.includes(urlPane) && urlPane) ||
      (stored && syncPaneIds.includes(stored) && stored) ||
      syncPaneIds[0] ||
      null
    );
  })();

  // Keep `?pane` in step with the active pane — ONLY for the active tab in a
  // single-pane view, so hidden TabViews never fight over the shared URL.
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
    // Split view shows every pane at once — it has no single active pane. Just
    // strip a foreign/stale ?pane that leaked in: TanStack carries + re-validates
    // search across navigations, so a single-pane tab's ?pane rides along into
    // whatever tab you click next. Left in a split URL it's dead weight (and it's
    // another tab's pane id); clear it.
    if (!singlePane) {
      if (urlPane) {
        navigate({
          to: '/w/$wsSlug/t/$tabSlug',
          params: { wsSlug, tabSlug },
          search: (prev) => ({ ...prev, pane: undefined }),
          replace: true,
        });
      }
      return;
    }
    if (!syncActiveId || syncActiveId === urlPane) return;
    navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug, tabSlug },
      search: (prev) => ({ ...prev, pane: syncActiveId }),
      replace: true,
    });
  }, [
    isActive,
    singlePane,
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
    if (!singlePane || !tab || !isActive) {
      // Reset on deactivation so re-entering the tab refocuses its pane.
      if (!isActive) mobileFocusedRef.current = null;
      return;
    }
    const paneIds = collectPaneIds(toMosaic(tab.layout));
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
  }, [singlePane, tab, mobileActiveId, isActive]);

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
    const paneIds = collectPaneIds(toMosaic(tab.layout));
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

  // Forward the "+" tap from the chrome bar's TabBar (which lives in
  // AppLayout and can't reach into this component tree) to whatever
  // addPane the mobile branch most recently rendered. The same event
  // is also dispatched by the mobile top-bar "+" (MobilePaneChrome)
  // — one listener, two emitters.
  useEffect(() => {
    const onAddPane = () => addPaneRef.current?.();
    window.addEventListener('muxpad:add-pane', onAddPane);
    return () => window.removeEventListener('muxpad:add-pane', onAddPane);
  }, []);

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
  // the pane reacts. Single-pane views flip their active pane to it; the
  // split mosaic shows every pane anyway, so there it's a no-op.
  useEffect(() => {
    const onShowPane = (e: Event) => {
      const paneId = (e as CustomEvent<{ paneId?: string }>).detail?.paneId;
      if (!paneId || !tab) return;
      if (!collectPaneIds(toMosaic(tab.layout)).includes(paneId)) return;
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

  // Surgical mark-seen. Mobile: only the active pane (so other panes
  // can keep flagging in the dropdown). Desktop: bulk-seen because the
  // mosaic shows every pane at once — every pane is "seen" by virtue of
  // the tab being open. Fires on tab mount and on any pane switch.
  // Refreshes workspaces/tabs so the favicon + chrome dots update
  // without waiting for the 5s poll.
  //
  // For mobile we resolve the active pane through the same fallback
  // chain the render branch uses (state → last-visited storage → first
  // pane). Without this, the implicit-active pane on a fresh tab mount
  // (mobileActiveId still null) would never get mark-seen until the
  // user explicitly tapped it — leaving the attention dot stuck.
  const mobileActiveResolved = (() => {
    if (!isMobile || !tab) return null;
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
  useEffect(() => {
    if (!tab || !workspace || !isActive) return;
    // Debounced. `attention` is the BEL bit, and a pane can ring it in a tight
    // loop (shell completion beeps, a chatty build) — each ring moves the
    // signature, and each run costs a POST plus two list refetches. Coalescing
    // a storm into one round trip is free; the delay is imperceptible for
    // something whose whole job is to clear a dot on the tab you're watching.
    const t = window.setTimeout(() => {
      const refresh = () =>
        Promise.all([refreshTabs(workspace.id), refreshWorkspaces()]).catch(() => {});
      if (isMobile) {
        if (!mobileActiveResolved) return;
        api
          .markPaneSeen(mobileActiveResolved)
          .then(refresh)
          .catch(() => {});
      } else {
        api
          .markTabSeen(tab.id)
          .then(refresh)
          .catch(() => {});
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [tab?.id, mobileActiveResolved, isMobile, workspace?.id, isActive, seenSignature]);

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
  useEffect(() => {
    if (!tab) return;
    const updated = allTabs.find((t) => t.id === tab.id);
    if (updated && updated.name !== tab.name) {
      setTab((prev) => (prev ? { ...prev, name: updated.name } : prev));
    }
  }, [allTabs, tab?.id]);

  // While a react-mosaic splitter is being dragged, set `body.mosaic-dragging`
  // so iframes (URL panes) can be made pointer-events: none. Without this the
  // iframe captures mousemove/mouseup and the splitter sticks. Doc-level
  // capture-phase listeners run regardless of where the mouse currently is.
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.mosaic-split')) {
        document.body.classList.add('mosaic-dragging');
      }
    };
    const onUp = () => {
      document.body.classList.remove('mosaic-dragging');
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('touchend', onUp, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('touchend', onUp, true);
    };
  }, []);

  // Load this tab once when the TabView instance mounts. Each workspace
  // tab gets its own instance (kept alive while hidden) so switching
  // tabs does not tear down xterm panes. Title / fg / attention and
  // structural changes arrive via /ws/events after the initial load.
  useEffect(() => {
    void loadNonce; // dep is the retry trigger; no value needed in the body
    if (!workspace) return;
    setClosingTab(false);
    setError(null);
    let viewedTabId: string | null = null;
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
        const detail = await api.getTab(found.id);
        if (cancelled) return;
        setTab(detail);
        layoutRef.current = toMosaic(detail.layout);
        viewedTabId = found.id;
        // Mark-seen on mount is deliberately NOT done here anymore — a
        // bulk tab-seen on mount would clear every pane's attention
        // before the user could see which pane was BELing in the nav
        // sheet's pane list. The per-pane / per-mode seen happens
        // in the dedicated effect below; the bulk seen on unmount still
        // runs (tab-level dot still clears when you actually leave).
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (viewedTabId) {
        api
          .markTabSeen(viewedTabId)
          .then(() => Promise.all([refreshTabs(workspace.id), refreshWorkspaces()]))
          .catch(() => {});
      }
    };
  }, [workspace?.id, tabSlug, loadNonce]);

  const persistLayout = useCallback(
    async (layout: Layout) => {
      if (!tab) return;
      pendingLayoutWrites.current += 1;
      try {
        // SERIALIZED PER TAB. A whole-layout PATCH is last-writer-wins, so two
        // rapid structural edits (split, then reorder) racing on the wire could
        // land B before A — and A, written last, describes a tree that predates
        // B's newly created pane. The pane row survives but no layout mentions
        // it, and the settle-refetch faithfully adopts that wrong truth. The
        // chain makes the wire order match the user's order; it does not make
        // the write conditional, so a SECOND writer (another device) can still
        // win last — that's the same last-writer-wins the endpoint has always
        // had, and out of scope for a client-side fix.
        await enqueueLayoutWrite(tab.id, () =>
          api.patchTab(tab.id, { layout: fromMosaic(layout) }),
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

  useEffect(() => {
    if (editingPaneId) {
      paneEditRef.current?.focus();
      paneEditRef.current?.select();
    }
  }, [editingPaneId]);

  const notifyLayoutChanged = useCallback(() => {
    const fire = () => window.dispatchEvent(new Event('muxpad:layout-changed'));
    fire();
    requestAnimationFrame(fire);
    window.setTimeout(fire, 200);
    window.setTimeout(fire, 500);
  }, []);

  // Flip split ⇄ tabbed. The visible pane's container changes width (a split
  // tile → full width, or back), so nudge the terminals to refit — the mode
  // is its own tab field (PATCHed by setTabViewMode), never a layout write,
  // so the split tree survives the flip.
  const changeViewMode = useCallback(
    (next: 'split' | 'tabbed') => {
      if (!tab) return;
      setTabViewMode(tab.id, next);
      notifyLayoutChanged();
    },
    [tab, notifyLayoutChanged],
  );

  const onChange = useCallback(
    (layout: Layout) => {
      setTab((prev) => (prev ? { ...prev, layout: fromMosaic(layout) } : prev));
      layoutRef.current = layout;
      void persistLayout(layout);
      notifyLayoutChanged();
    },
    [persistLayout, notifyLayoutChanged],
  );

  const splitFromPane = useCallback(
    async (sourcePaneId: string | null, direction: MosaicDirection) => {
      if (!tab) return;
      const created = await api.createPane(tab.id, {
        ...(sourcePaneId ? { inherit_cwd_from: sourcePaneId } : {}),
        // New panes are the house chat, same as new tabs. The alternatives
        // (raw Claude/Codex/Cursor, terminal, web) live in the empty chat's
        // own "open instead:" strip.
        ...HOUSE_CHAT_PANE_CREATE,
      });
      const newLayout =
        sourcePaneId == null
          ? created.id
          : splitAtPane(layoutRef.current, sourcePaneId, created.id, direction);
      layoutRef.current = newLayout;
      // Persist the new pane as last-focused so the autoFocus gate on
      // its mount evaluates to true (otherwise desktopFocusTarget would
      // still resolve to the source pane and the new pane would mount
      // without focus — surprising right after the user clicked split).
      setLastPaneId(tab.id, created.id);
      setTab((prev) =>
        prev
          ? {
              ...prev,
              layout: fromMosaic(newLayout),
              // Dedup: the pane.added event for `created` may have already
              // landed and appended it (it carries the same id).
              panes: prev.panes.some((p) => p.id === created.id)
                ? prev.panes
                : [...prev.panes, created],
            }
          : prev,
      );
      await persistLayout(newLayout);
      notifyLayoutChanged();
    },
    [tab, persistLayout, notifyLayoutChanged],
  );

  // Navigate to a tab we just moved a pane into — "follow the pane" so the
  // move is immediately visible (and the user isn't stranded on a source tab
  // that may have just auto-closed). setLastTabSlug first so the
  // workspace-root redirect resolves here if a source `tab.removed` races us.
  const followToTab = useCallback(
    (toTab: Tab) => {
      setLastTabSlug(wsSlug, toTab.slug);
      void navigate({ to: '/w/$wsSlug/t/$tabSlug', params: { wsSlug, tabSlug: toTab.slug } });
    },
    [navigate, wsSlug],
  );

  /**
   * Move a pane to another tab in this workspace (existing tab via
   * `toTabId`, or a fresh one via `newTab`).
   *
   * Extract (`newTab`) FOLLOWS the pane to its new tab — but only after
   * priming the tab/workspace caches, or WorkspaceShell's stale-URL recovery
   * would bounce off a slug it hasn't seen yet. Move-to-existing deliberately
   * does NOT navigate: you stay put and the pane simply leaves your view
   * ("send away"); if the source tab empties, its own `tab.removed` handler
   * redirects you to a neighbor.
   *
   * `paneLabelText` is captured at call time for the undo message (paneLabel
   * itself is only in scope after the loading early-returns).
   */
  const movePane = useCallback(
    async (paneId: string, paneLabelText: string, dest: { toTabId?: string; newTab?: boolean }) => {
      if (!tab || !workspace) return;
      const sourceSlug = tab.slug;
      const followed = dest.newTab === true;
      try {
        const res = await api.movePane(paneId, dest);
        // Server declined (e.g. extracting a sole pane is a no-op): nothing
        // moved, so no follow and no undo.
        if (res.to_tab.id === res.from_tab_id) return;
        if (followed) {
          await Promise.all([refreshTabs(workspace.id), refreshWorkspaces()]);
          followToTab(res.to_tab);
        }
        if (!res.from_tab_removed) {
          pushUndo({
            message: `Moved “${paneLabelText}” to “${res.to_tab.name}”`,
            run: async () => {
              // Navigate back to the SOURCE tab BEFORE reversing the move (for
              // the extract case — move-to-existing never left, so no nav).
              // Order matters: reversing the move empties and deletes the
              // extracted tab we're viewing; if we're still on it when that
              // happens, its `tab.removed` handler redirects to the
              // workspace's FIRST tab, overriding our jump to the source.
              // Navigating first makes the extracted tab inactive, so the
              // isActive guard suppresses that redirect and we land on the
              // tab the pane actually returned to.
              if (followed) {
                setLastTabSlug(wsSlug, sourceSlug);
                void navigate({
                  to: '/w/$wsSlug/t/$tabSlug',
                  params: { wsSlug, tabSlug: sourceSlug },
                });
              }
              try {
                await api.movePane(paneId, { toTabId: res.from_tab_id });
              } catch (err) {
                console.error('undo move failed', err);
              }
            },
          });
        }
      } catch (err) {
        console.error('move pane failed', err);
      }
    },
    [tab, workspace, followToTab, navigate, wsSlug],
  );

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
              layout: fromMosaic(newLayout),
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

  const killPane = useCallback(
    (paneId: string) => removePaneFromLayout(paneId),
    [removePaneFromLayout],
  );

  const onPaneExited = useCallback(
    (paneId: string) => {
      void removePaneFromLayout(paneId);
    },
    [removePaneFromLayout],
  );

  /**
   * Optimistically reflect a kind flip from the type-switch button into
   * local tab.panes. The server already returned the updated pane row
   * (see PaneSurfaceSwitch → patchPane callers), so we can splice it in now
   * instead of waiting for the pane.updated event to round-trip — which
   * is fast on localhost but still perceptible.
   * Must be declared BEFORE the early-returns below — otherwise the hook
   * count differs between loading-state and loaded-state renders, which
   * trips React's rules-of-hooks check.
   */
  const onKindToggled = useCallback((updated: PaneSpec) => {
    setTab((prev) =>
      prev
        ? {
            ...prev,
            panes: prev.panes.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)),
          }
        : prev,
    );
  }, []);

  // Subscribe to server-pushed events for the currently-viewed tab.
  // This is the ONLY source of structural updates after the initial load
  // — there's no 5s poll fallback anymore.
  //
  // MUST live before the early-return below; same rules-of-hooks issue
  // we fixed in commit 8937e0e for onKindToggled.
  //
  // The `tab` closure may go stale when the user navigates to a
  // different tab, but `tab?.id` is in the dep array so the effect
  // re-subscribes on tab change. We still filter on `e.tab_id ===
  // tab.id` defensively in case any in-flight events slip through.
  //
  // pane.updated merges rather than overwrites: PATCH-route events
  // carry the raw row without runtime decorations (title,
  // foreground_cmd), so we preserve old values when the incoming
  // payload omits them. PaneManager-emitted events do carry the
  // decorations and overwrite cleanly.
  useEffect(() => {
    if (!tab) return;
    const tabId = tab.id;
    return subscribe((e) => {
      if (e.type === 'pane.added' && e.tab_id === tabId) {
        setTab((prev) =>
          prev && !prev.panes.some((p) => p.id === e.pane.id)
            ? { ...prev, panes: [...prev.panes, e.pane] }
            : prev,
        );
      } else if (e.type === 'pane.removed' && e.tab_id === tabId) {
        setTab((prev) =>
          prev ? { ...prev, panes: prev.panes.filter((p) => p.id !== e.pane_id) } : prev,
        );
      } else if (e.type === 'pane.updated' && e.tab_id === tabId) {
        setTab((prev) =>
          prev
            ? {
                ...prev,
                panes: prev.panes.map((p) => {
                  if (p.id !== e.pane.id) return p;
                  return {
                    ...e.pane,
                    title: e.pane.title ?? p.title ?? null,
                    foreground_cmd: e.pane.foreground_cmd ?? p.foreground_cmd ?? null,
                    // Like title/fg above: PATCH-route events may omit the
                    // runtime-only attention flag. Preserve prior so we
                    // don't clobber a true value with undefined.
                    attention: e.pane.attention ?? p.attention,
                    // Same for the runtime-only status channel. The server now
                    // decorates every pane.updated, but a version-skewed (or
                    // future partial) emitter must not be able to blank the
                    // status mark mid-turn — coalescing is the cheap invariant.
                    // `status`/`agents` are the fields this file actually
                    // RENDERS (the tabbed strip's StatusMark); `busy` is the
                    // deprecated alias, coalesced for anything still reading it.
                    status: e.pane.status ?? p.status,
                    agents: e.pane.agents ?? p.agents,
                    busy: e.pane.busy ?? p.busy,
                    // Same: a PATCH-route pane.updated carries the raw row
                    // without runtime app_urls. Coalesce so a kind/url edit
                    // doesn't transiently blank the web-switch dropdown.
                    app_urls: e.pane.app_urls ?? p.app_urls,
                  };
                }),
              }
            : prev,
        );
      } else if (e.type === 'tab.updated' && e.tab.id === tabId) {
        // Skip the layout if we have a local layout write in flight — this
        // snapshot may predate it and would revert an optimistic split. But
        // REMEMBER the skip: the frame may also carry someone else's change
        // (a merge landing panes into this tab), and dropping it silently
        // would leave those panes in state but never in the mosaic. When the
        // write settles, persistLayout refetches the server truth.
        const applyLayout = pendingLayoutWrites.current === 0;
        if (!applyLayout) skippedTabUpdate.current = true;
        setTab((prev) =>
          prev
            ? {
                ...prev,
                name: e.tab.name,
                slug: e.tab.slug,
                ...(applyLayout ? { layout: e.tab.layout } : {}),
                // tab.updated is emitted from PATCH /tabs and from pane
                // append/remove paths; the server-side Tab row doesn't
                // carry the runtime-only `attention` field, so e.tab.attention
                // is undefined here. Coalesce to prev so we don't clobber
                // the locally-tracked dot.
                attention: e.tab.attention ?? prev.attention,
                updated_at: e.tab.updated_at,
              }
            : prev,
        );
        if (applyLayout) layoutRef.current = toMosaic(e.tab.layout);
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
  // (re)connects. Any pane.added/removed/updated emitted during the
  // disconnect window was lost, and the subscribe() effect above only
  // delivers events from now on. Without this re-fetch, an active tab
  // could keep stale panes/layout indefinitely after a server restart
  // or network blip — refresh covers what events couldn't.
  useEffect(() => {
    if (!tab) return;
    const tabId = tab.id;
    return subscribeReconnect(() => {
      void api
        .getTab(tabId)
        .then((detail) => {
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
          if (applyLayout) layoutRef.current = toMosaic(detail.layout);
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

  // Desktop autoFocus target: the persisted last-focused pane if it
  // still exists in this tab, otherwise the first pane. Used as the
  // single pane allowed to auto-focus on mount so a refresh doesn't
  // hand focus to whichever pane finishes opening last.
  const desktopFocusTarget = (() => {
    if (isMobile || tab.panes.length === 0) return null;
    const ids = tab.panes.map((p) => p.id);
    const stored = getLastPaneId(tab.id);
    if (stored && ids.includes(stored)) return stored;
    return ids[0] ?? null;
  })();

  const paneNumber = (paneId: string): number => tab.panes.findIndex((p) => p.id === paneId) + 1;

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
    return `Pane ${paneNumber(paneId)}`;
  };

  // ── Pane-header rename (tab strip) ───────────────────────────────────────
  const startPaneRename = (paneId: string) => {
    setEditingPaneId(paneId);
    // Seed with the currently-shown label so pinning the live title is a
    // double-click-then-Enter; the user edits from what they already see.
    setPaneDraft(paneLabel(paneId));
  };

  const commitPaneRename = async () => {
    const id = editingPaneId;
    if (!id) return;
    setEditingPaneId(null);
    const target = tab.panes.find((p) => p.id === id);
    if (!target) return;
    const next = paneDraft.trim();
    const current = (target.name ?? '').trim();
    if (next === current) return;
    // Optimistic: update local pane.name immediately (empty → clear/revert).
    setTab((prev) =>
      prev
        ? {
            ...prev,
            panes: prev.panes.map((p) => (p.id === id ? { ...p, name: next || null } : p)),
          }
        : prev,
    );
    try {
      await api.patchPane(id, { name: next || null });
    } catch (err) {
      console.error('pane rename failed', err);
    }
  };

  const cancelPaneRename = () => setEditingPaneId(null);

  // ── Pane-header drag-to-reorder ──────────────────────────────────────────
  const reorderPanes = async (sourceId: string, targetId: string, side: 'before' | 'after') => {
    if (sourceId === targetId) return;
    const ids = collectPaneIds(layoutRef.current);
    const sourceIdx = ids.indexOf(sourceId);
    if (sourceIdx === -1) return;
    ids.splice(sourceIdx, 1);
    let insertAt = ids.indexOf(targetId);
    if (insertAt === -1) return;
    if (side === 'after') insertAt += 1;
    ids.splice(insertAt, 0, sourceId);
    const newLayout = buildRowLayout(ids);
    layoutRef.current = newLayout;
    setTab((prev) => (prev ? { ...prev, layout: fromMosaic(newLayout) } : prev));
    await persistLayout(newLayout);
    notifyLayoutChanged();
  };

  const onPaneDragStart = (e: ReactDragEvent, id: string) => {
    e.dataTransfer.setData(PANE_DRAG_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setPaneDragId(id);
    // Mirror the origin so sidebar tab rows can gate their move-here drop
    // affordance during dragover (when the payload itself is unreadable).
    if (tab)
      paneDragOrigin.set({
        paneId: id,
        fromTabId: tab.id,
        ...(workspace ? { fromWorkspaceId: workspace.id } : {}),
        soloPane: tab.panes.length <= 1,
      });
  };
  const onPaneDragOver = (e: ReactDragEvent, id: string) => {
    if (!paneDragId || paneDragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setPaneDropTargetId(id);
    setPaneDropSide(side);
  };
  const onPaneDragEnd = () => {
    paneDragOrigin.set(null);
    setPaneDragId(null);
    setPaneDropTargetId(null);
  };
  const onPaneDrop = (e: ReactDragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData(PANE_DRAG_MIME) || paneDragId;
    const side = paneDropSide;
    setPaneDragId(null);
    setPaneDropTargetId(null);
    if (!sourceId) return;
    void reorderPanes(sourceId, targetId, side);
  };

  if (isMobile && !isEmpty) {
    const paneIds = collectPaneIds(layout);
    // Fallback chain: in-memory state → persisted last pane for this
    // tab → first pane. Lets a workspace/tab switch land back on the
    // pane the user was last looking at, not always paneIds[0].
    const stored = tab ? getLastPaneId(tab.id) : undefined;
    const activeId =
      mobileActiveId && paneIds.includes(mobileActiveId)
        ? mobileActiveId
        : stored && paneIds.includes(stored)
          ? stored
          : (paneIds[0] ?? null);

    const addPane = async () => {
      if (!tab) return;
      const target = activeId ?? paneIds[paneIds.length - 1];
      const created = await api.createPane(tab.id, {
        ...(target ? { inherit_cwd_from: target } : {}),
        ...HOUSE_CHAT_PANE_CREATE,
      });
      // Append at the END — same convention as the desktop strip's +.
      const newLayout: Layout =
        layoutRef.current == null
          ? created.id
          : { direction: 'row', first: layoutRef.current, second: created.id };
      layoutRef.current = newLayout;
      setTab((prev) =>
        prev
          ? {
              ...prev,
              layout: fromMosaic(newLayout),
              // Dedup: the pane.added event for `created` may have already
              // landed and appended it (it carries the same id).
              panes: prev.panes.some((p) => p.id === created.id)
                ? prev.panes
                : [...prev.panes, created],
            }
          : prev,
      );
      setMobileActiveId(created.id);
      await persistLayout(newLayout);
      notifyLayoutChanged();
    };
    addPaneRef.current = isActive ? () => void addPane() : null;

    return (
      <div className="workspace-root workspace-mobile">
        {/* Pane row only renders when there's more than one pane to
            choose between. The "+" inside it dispatches muxpad:add-pane;
            TabView listens at the window level and forwards to the
            mobile branch's addPane closure. */}
        {/* Pane-level controls now live in the TOP bar (line 1), not a second
            strip: mobile spends no whole row on chrome. The nav sheet owns pane
            SWITCH + CLOSE (the old picker & ×), leaving just the face switch
            (what am I looking at) and an always-visible + (new pane). Portalled
            up because the top bar (AppLayout) has no pane context; gated on
            isActive so kept-mounted hidden tabs don't paint duplicates. */}
        {isActive
          ? (() => {
              const ap = activeId ? tab.panes.find((p) => p.id === activeId) : undefined;
              const webSwitch =
                ap &&
                ap.kind === 'shell' &&
                !(ap.startup_cmd?.startsWith('muxpad agent') ?? false) ? (
                  <PaneWebSwitch
                    paneId={ap.id}
                    appUrls={ap.app_urls ?? []}
                    startupCmd={ap.startup_cmd}
                  />
                ) : null;
              return (
                <MobilePaneChrome>
                  {webSwitch ? <div className="mobile-strip-webswitch">{webSwitch}</div> : null}
                  <NewTabButton
                    idleLabel="+"
                    idleTitle="New pane"
                    idleClassName="mobile-strip-add"
                    onCreate={() => void addPane()}
                  />
                </MobilePaneChrome>
              );
            })()
          : null}
        <main className="workspace-body workspace-body-mobile">
          {paneIds.map((paneId) => {
            const pane = tab.panes.find((p) => p.id === paneId);
            if (!pane) return null;
            const paneIsActive = paneId === activeId;
            return (
              <div
                key={paneId}
                className="mobile-pane-slot"
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
        <MobileInputBar
          paneId={activeId}
          paneKind={tab.panes.find((p) => p.id === activeId)?.kind ?? null}
          foregroundCmd={tab.panes.find((p) => p.id === activeId)?.foreground_cmd ?? null}
        />
      </div>
    );
  }

  // ── Desktop 'tabbed' mode ────────────────────────────────────────────────
  // Browser-style tab headers over a single visible pane. Same panes, same
  // stable keys as the split mosaic — flipping here never remounts a terminal
  // (see tab-view-mode.ts). Deliberately mirrors the mobile branch's
  // single-pane arrangement; the only real difference is inline tab headers
  // instead of a dropdown chooser.
  if (viewMode === 'tabbed' && !isEmpty) {
    const paneIds = collectPaneIds(layout);
    const stored = tab ? getLastPaneId(tab.id) : undefined;
    const activeId =
      mobileActiveId && paneIds.includes(mobileActiveId)
        ? mobileActiveId
        : stored && paneIds.includes(stored)
          ? stored
          : (paneIds[0] ?? null);

    const addPane = async () => {
      const target = activeId ?? paneIds[paneIds.length - 1];
      const created = await api.createPane(tab.id, {
        ...(target ? { inherit_cwd_from: target } : {}),
        ...HOUSE_CHAT_PANE_CREATE,
      });
      // The strip's "+" appends at the END (browser-tab convention).
      // Splitting at the active pane put the newcomer mid-strip whenever a
      // middle tab was active — cwd inheritance still follows the active
      // pane above.
      const newLayout: Layout =
        layoutRef.current == null
          ? created.id
          : { direction: 'row', first: layoutRef.current, second: created.id };
      layoutRef.current = newLayout;
      setTab((prev) =>
        prev
          ? {
              ...prev,
              layout: fromMosaic(newLayout),
              panes: prev.panes.some((p) => p.id === created.id)
                ? prev.panes
                : [...prev.panes, created],
            }
          : prev,
      );
      setMobileActiveId(created.id);
      await persistLayout(newLayout);
      notifyLayoutChanged();
    };

    const closePane = (paneId: string) => {
      if (paneId === activeId) {
        const idx = paneIds.indexOf(paneId);
        setMobileActiveId(paneIds[idx + 1] ?? paneIds[idx - 1] ?? null);
      }
      void killPane(paneId);
    };

    return (
      <div className="workspace-root">
        <nav className="desktop-tab-strip" aria-label="Panes">
          <div className="desktop-tab-strip-tabs" role="tablist">
            {paneIds.map((paneId) => {
              const p = tab.panes.find((x) => x.id === paneId);
              const isActiveTab = paneId === activeId;
              const isEditing = editingPaneId === paneId;
              return (
                <div
                  key={paneId}
                  className="desktop-tab"
                  data-active={isActiveTab ? 'true' : undefined}
                  data-drop={paneDropTargetId === paneId ? paneDropSide : undefined}
                  data-dragging={paneDragId === paneId ? 'true' : undefined}
                  // Editing borrows the header for a text input; dragging then
                  // would steal the pointer selection, so disable it mid-edit.
                  draggable={!isEditing}
                  onDragStart={(e) => onPaneDragStart(e, paneId)}
                  onDragOver={(e) => onPaneDragOver(e, paneId)}
                  onDragEnd={onPaneDragEnd}
                  onDrop={(e) => onPaneDrop(e, paneId)}
                >
                  {isEditing ? (
                    <input
                      ref={paneEditRef}
                      className="desktop-tab-input"
                      value={paneDraft}
                      onChange={(e) => setPaneDraft(e.target.value)}
                      onBlur={() => void commitPaneRename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitPaneRename();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelPaneRename();
                        }
                      }}
                      size={Math.max(6, paneDraft.length + 1)}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActiveTab}
                        className="desktop-tab-select"
                        onClick={() => setMobileActiveId(paneId)}
                        onDoubleClick={() => startPaneRename(paneId)}
                        title={p?.name ? p.name : 'Double-click to rename'}
                      >
                        <span
                          className="desktop-tab-kind"
                          title={paneSurfaceLabel(p)}
                          aria-label={paneSurfaceLabel(p)}
                        >
                          {paneSurfaceIcon(p)}
                        </span>
                        <span className="desktop-tab-label">{paneLabel(paneId)}</span>
                        {/* The same status rail the navigator uses — one
                            component, so the strip and the sidebar can never
                            tell different stories about the same pane. */}
                        <StatusMark status={p?.status} />
                      </button>
                      {/* Trailing slot holds only the hover-revealed × now —
                          status moved to LEAD the label. */}
                      <span className="desktop-tab-trailing">
                        <button
                          type="button"
                          className="desktop-tab-close"
                          title="Close pane"
                          aria-label="Close pane"
                          onClick={() => closePane(paneId)}
                        >
                          {/* 13 → ~8px drawn X with a light stroke — reads
                              as the face glyph's equal (a 16px X overpowered
                              its thin 14px outline). */}
                          <SvgClose size={13} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              );
            })}
            {/* Browser-standard lone "+"; always opens the harness picker
                (Claude / Codex / Cursor + Terminal below). */}
            <NewTabButton
              idleLabel="+"
              idleTitle="New pane"
              idleClassName="desktop-tab-add desktop-tab-add-plus"
              onCreate={() => void addPane()}
            />
          </div>
          <div className="desktop-tab-strip-actions">
            <button
              type="button"
              className="pane-chrome-btn"
              title="Expand to split"
              aria-label="Expand to split view"
              onClick={() => changeViewMode('split')}
            >
              <SvgSplitView />
            </button>
          </div>
        </nav>
        <main className="workspace-body">
          {/* Render the pane bodies in a STABLE order (sorted pane id), NOT in
              tab-strip order. Only one slot is visible at a time (absolutely
              positioned, full-bleed), so their DOM order is invisible — but if
              the bodies followed the header order, dragging to reorder a tab
              would move the active pane's DOM node via insertBefore. Moving an
              xterm/iframe node reloads it and refits it to a transient (often
              half) width. Keeping the bodies put means a reorder only shuffles
              the cheap header divs; the terminal never moves. */}
          {[...paneIds].sort().map((paneId) => {
            const pane = tab.panes.find((p) => p.id === paneId);
            if (!pane) return null;
            const paneIsActive = paneId === activeId;
            return (
              <div
                key={paneId}
                className="tabbed-pane-slot"
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
        <ExternalOpenToasts
          currentTabId={tab.id}
          paneLabel={(id) => (tab.panes.some((p) => p.id === id) ? paneLabel(id) : null)}
        />
      </div>
    );
  }

  return (
    <div className="workspace-root">
      {/* In split (bsplit) mode we still keep the top strip present so the
          workspace's top edge is stable across the split⇄tabbed flip and the
          sidebar brand lines up with it. It carries no pane headers here —
          just the mirror of the tabbed strip's mode toggle, in the same
          right-hand slot, to collapse the whole split into a tabbed view. */}
      {!isEmpty && (
        <nav className="desktop-tab-strip -split" aria-label="Panes">
          <div className="desktop-tab-strip-tabs" />
          <div className="desktop-tab-strip-actions">
            <button
              type="button"
              className="pane-chrome-btn"
              title="Collapse to tabs"
              aria-label="Switch to tabbed view"
              onClick={() => changeViewMode('tabbed')}
            >
              <SvgTabsView />
            </button>
          </div>
        </nav>
      )}
      <main className="workspace-body">
        {isEmpty ? (
          <div className="workspace-empty">
            <p>This tab has no panes.</p>
            <button className="btn btn-primary" onClick={() => void splitFromPane(null, 'row')}>
              New pane
            </button>
            <button type="button" className="workspace-empty-close" onClick={() => void closeTab()}>
              or close this tab
            </button>
          </div>
        ) : (
          <Mosaic<string>
            renderTile={(paneId, path) => {
              const label = paneLabel(paneId);
              const tilePane = tab.panes.find((p) => p.id === paneId);
              const isUrl = tilePane?.kind === 'url';
              return (
                <MosaicWindow<string>
                  path={path}
                  title=""
                  renderToolbar={() => (
                    <div className="pane-chrome">
                      {isUrl ? (
                        <UrlPaneTitle paneId={paneId} onKindToggled={onKindToggled} />
                      ) : (
                        <ShellPaneTitle
                          paneId={paneId}
                          label={label}
                          appUrls={tilePane?.app_urls ?? []}
                          startupCmd={tilePane?.startup_cmd}
                          onKindToggled={onKindToggled}
                        />
                      )}
                      {isUrl && (
                        <button
                          className="pane-chrome-btn pane-chrome-btn-inline"
                          title="Reload"
                          aria-label="Reload"
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent('muxpad:reload-url-pane', {
                                detail: { paneId },
                              }),
                            )
                          }
                        >
                          <SvgReload />
                        </button>
                      )}
                      <span className="pane-chrome-spacer" />
                      <button
                        className="pane-chrome-btn"
                        title="Split right"
                        aria-label="Split right"
                        onClick={() => void splitFromPane(paneId, 'row')}
                      >
                        <SvgSplitRight />
                      </button>
                      <button
                        className="pane-chrome-btn"
                        title="Split down"
                        aria-label="Split down"
                        onClick={() => void splitFromPane(paneId, 'column')}
                      >
                        <SvgSplitDown />
                      </button>
                      {/* The split⇄tabbed toggle lives once, in the top strip's
                          right slot (mirroring tabbed mode's "expand to split"),
                          not per-pane — so it's not repeated here. */}
                      {/* One-click "pop this pane out into its own tab". Only
                          shown when the tab has another pane to leave behind —
                          extracting a sole pane is a no-op. Moving a pane to an
                          EXISTING tab is intentionally not a chrome dropdown
                          (cramped, and clipped in narrow panes); that belongs on
                          a drag-onto-sidebar-tab gesture. */}
                      {tab.panes.length > 1 && (
                        <button
                          className="pane-chrome-btn"
                          title="Pop out to a new tab"
                          aria-label="Pop out to a new tab"
                          onClick={() => void movePane(paneId, paneLabel(paneId), { newTab: true })}
                        >
                          <SvgMove />
                        </button>
                      )}
                      <button
                        className="pane-chrome-btn pane-chrome-close"
                        title="Close pane"
                        aria-label="Close pane"
                        onClick={() => void killPane(paneId)}
                      >
                        <SvgClose size={12} />
                      </button>
                    </div>
                  )}
                >
                  {tilePane && (
                    <PaneBody
                      pane={tilePane}
                      onExit={() => onPaneExited(paneId)}
                      autoFocus={paneId === desktopFocusTarget}
                      paneActive={isActive}
                    />
                  )}
                </MosaicWindow>
              );
            }}
            value={layout}
            onChange={onChange}
            blueprintNamespace="bp4"
          />
        )}
      </main>
      <ExternalOpenToasts
        currentTabId={tab.id}
        // Return null for ids that aren't in this tab's pane list so the
        // toast can show the generic "A pane requested..." fallback
        // instead of paneLabel's "Pane 1" position-based fallback (which
        // would be misleading for an unknown id).
        paneLabel={(id) => (tab.panes.some((p) => p.id === id) ? paneLabel(id) : null)}
      />
    </div>
  );
}

/**
 * Renders the body of a pane based on its `kind`. URL panes get
 * `<UrlPane>` (iframe); shell panes get `<XtermPane>` (terminal).
 * The mosaic chrome (toolbar, splitter handles) is owned by the
 * caller — `PaneBody` is just the content.
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

/**
 * Leftmost chrome button that opens a popover with the available pane
 * types. Click outside or Esc closes. Selecting the current type is a
 * no-op (the menu item is disabled). Doubles as the URL pane loading
 * indicator via the optional `loading` prop, which overlays a spinner
 * ring on the icon.
 */
/**
 * The single "what surface is this pane" control, leftmost in the pane chrome
 * for BOTH shell and url panes. It merges what used to be two separate
 * terminal/web affordances:
 *   - the pane *kind* switch (shell ⇄ url — a destructive conversion), and
 *   - the shell pane *face* switch (terminal ⇄ a detected served app, which
 *     keeps the terminal alive behind it).
 *
 * UX hierarchy: the icon reflects the current surface and its click does the
 * frequent, non-destructive thing (flip to a detected app / back to terminal);
 * the caret opens the full menu; the rare destructive kind-conversion sits
 * below a separator. When a shell pane is serving an app, the control lights
 * (accent + pulse) to advertise it. The mobile layout keeps its own
 * PaneWebSwitch bar — this control is the desktop chrome's.
 */
function PaneSurfaceSwitch({
  paneId,
  currentKind,
  appUrls = [],
  startupCmd,
  loading,
  onSelect,
}: {
  paneId: string;
  currentKind: 'shell' | 'url';
  appUrls?: AppUrl[];
  startupCmd?: string | null | undefined;
  loading?: boolean;
  onSelect: (next: 'shell' | 'url') => void;
}) {
  const { face, url } = usePaneFace(paneId);
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useDismissable(menuAt !== null, wrapperRef, () => setMenuAt(null));
  useEffect(() => {
    if (!menuAt) return;
    // The menu is position:fixed (measured from the trigger) — coords go
    // stale on scroll/resize, so just close.
    const close = () => setMenuAt(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuAt]);

  const onChat = currentKind === 'shell' && face === 'chat';
  const onWeb = currentKind === 'shell' && face === 'web' && !!url;
  const showsGlobe = currentKind === 'url' || onWeb;
  const Icon = showsGlobe ? SvgGlobe : SvgTerminal;
  // Terminal face + a detected app: advertise it (accent + pulse dot).
  const available = currentKind === 'shell' && !onWeb && appUrls.length > 0;

  const close = () => setMenuAt(null);
  const toggle = () => {
    if (menuAt) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuAt({ top: rect.bottom + 4, left: clampMenuLeft(rect.left) });
  };

  // One control, one job: the icon shows the CURRENT surface and the whole
  // button opens the menu. No magic toggle — every change is an explicit,
  // labeled menu item. Face selection (terminal/chat/web URLs) is the shared
  // PaneFaceMenuList; the destructive pane-KIND conversion is appended below
  // its separator.
  const surfaceWord = onChat ? 'chat' : showsGlobe ? 'web' : 'terminal';

  return (
    <div className="pane-surface-switch" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`pane-surface-trigger${available ? ' is-available' : ''}`}
        title={`Showing ${surfaceWord} — pane options`}
        aria-label={`Showing ${surfaceWord} — pane options`}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {onChat ? <SvgAgentGlyph /> : <Icon />}
        {loading && <span className="pane-chrome-typeswitch-spinner" aria-hidden="true" />}
        {available && <span className="pane-surface-dot" aria-hidden="true" />}
        <SvgChevron />
      </button>
      {menuAt &&
        (currentKind === 'shell' ? (
          <PaneFaceMenuList
            paneId={paneId}
            appUrls={appUrls}
            startupCmd={startupCmd}
            at={menuAt}
            onClose={close}
          >
            <button
              type="button"
              role="menuitem"
              className="pane-web-switch-item pane-web-switch-convert"
              title="Replace this terminal with a standalone web pane — the terminal (and anything running in it) is closed."
              onClick={() => {
                close();
                onSelect('url');
              }}
            >
              <SvgGlobe />
              <span className="pane-web-switch-item-label">Convert to web pane</span>
              <span className="pane-web-switch-note">closes terminal</span>
            </button>
          </PaneFaceMenuList>
        ) : (
          <div
            className="pane-web-switch-menu is-fixed"
            role="menu"
            style={{ top: menuAt.top, left: menuAt.left }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="pane-web-switch-item"
              onClick={() => {
                close();
                onSelect('shell');
              }}
            >
              <SvgTerminal />
              <span className="pane-web-switch-item-label">Convert to terminal</span>
            </button>
          </div>
        ))}
    </div>
  );
}

function SvgMove() {
  // Pane glyph with an arrow leaving it — "send this pane elsewhere".
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="6.5"
        height="6.5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M6.5 11 H11.5 M9.3 8.8 L11.8 11 L9.3 13"
        transform="translate(0 -2.5)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SvgChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M3 4.5 L6 7.5 L9 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Fixed (non-interactive) surface mark for a pane tab: agent / web / terminal. */
function paneSurfaceKind(p: PaneSpec | undefined): 'agent' | 'web' | 'terminal' {
  if (!p) return 'terminal';
  if (p.kind === 'url') return 'web';
  if (p.startup_cmd?.startsWith('muxpad agent') || p.face === 'chat') return 'agent';
  if (p.face === 'web' && p.face_url) return 'web';
  return 'terminal';
}

function paneSurfaceLabel(p: PaneSpec | undefined): string {
  const k = paneSurfaceKind(p);
  if (k === 'agent') return 'Agent';
  if (k === 'web') return 'Web view';
  return 'Terminal';
}

function paneSurfaceIcon(p: PaneSpec | undefined) {
  const k = paneSurfaceKind(p);
  if (k === 'agent') return <SvgAgentGlyph />;
  if (k === 'web') return <SvgGlobe />;
  return <SvgTerminal />;
}

/**
 * Mosaic chrome for a URL pane: kind switch (+ load spinner). The address
 * bar lives inside UrlPane so tabbed/mobile (no mosaic toolbar) can set and
 * change the URL too.
 */
function UrlPaneTitle({
  paneId,
  onKindToggled,
}: {
  paneId: string;
  onKindToggled: (updated: PaneSpec) => void;
}) {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onLoading = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.paneId !== paneId) return;
      setLoading(!!detail.loading);
    };
    window.addEventListener('muxpad:url-pane-loading', onLoading);
    return () => window.removeEventListener('muxpad:url-pane-loading', onLoading);
  }, [paneId]);

  const handleSwitch = async (next: 'shell' | 'url') => {
    try {
      const updated = await api.patchPane(paneId, { kind: next });
      onKindToggled(updated);
    } catch (err) {
      console.error(`patchPane kind=${next} failed`, err);
    }
  };

  return (
    <PaneSurfaceSwitch
      paneId={paneId}
      currentKind="url"
      loading={loading}
      onSelect={handleSwitch}
    />
  );
}

/**
 * Pane chrome title for shell panes. Adds a leftmost terminal-icon button
 * that type-switches the pane to a URL pane (with url=null — UrlPaneTitle
 * then auto-enters edit mode so the user can type a URL). The title link
 * itself is unchanged from the prior inline shell-pane chrome.
 */
function ShellPaneTitle({
  paneId,
  label,
  appUrls,
  startupCmd,
  onKindToggled,
}: {
  paneId: string;
  label: string;
  appUrls: AppUrl[];
  startupCmd?: string | null | undefined;
  onKindToggled: (updated: PaneSpec) => void;
}) {
  const handleSwitch = async (next: 'shell' | 'url') => {
    try {
      const updated = await api.patchPane(paneId, { kind: next });
      onKindToggled(updated);
    } catch (err) {
      console.error(`patchPane kind=${next} failed`, err);
    }
  };
  return (
    <>
      <PaneSurfaceSwitch
        paneId={paneId}
        currentKind="shell"
        appUrls={appUrls}
        startupCmd={startupCmd}
        onSelect={handleSwitch}
      />
      <a
        href={`/p/${paneId}`}
        className="pane-chrome-title-link"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
        }}
        title="Cmd/Ctrl-click to open in new tab"
      >
        <span className="pane-chrome-title">{label}</span>
      </a>
    </>
  );
}

function SvgReload() {
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M11.5 7a4.5 4.5 0 1 1-1.32-3.18M11.5 2v2.5h-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SvgSplitRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1"
        y="2"
        width="5"
        height="10"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="8" y="2" width="5" height="10" rx="1" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function SvgSplitDown() {
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="2"
        y="1"
        width="10"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="2" y="8" width="10" height="5" rx="1" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function SvgTabsView() {
  // Two stacked header tabs over a body — reads as "browser tabs".
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1"
        y="4"
        width="12"
        height="9"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="2" y="1.5" width="4.5" height="3" rx="0.8" fill="currentColor" opacity="0.7" />
      <rect x="7" y="1.5" width="4.5" height="3" rx="0.8" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

function SvgSplitView() {
  // Two side-by-side panes — reads as "tiled split".
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1"
        y="2"
        width="5"
        height="10"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="8"
        y="2"
        width="5"
        height="10"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function SvgGlobe() {
  // Simple globe: outline circle + a vertical meridian + horizontal equator.
  // Stays legible at 16px in the chrome row.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <ellipse
        cx="7"
        cy="7"
        rx="2.4"
        ry="5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.0"
      />
      <line x1="1.8" y1="7" x2="12.2" y2="7" stroke="currentColor" strokeWidth="1.0" />
    </svg>
  );
}

function SvgTerminal() {
  // Chevron prompt + short cursor underline — instantly reads as "terminal".
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1"
        y="2"
        width="12"
        height="10"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M3.6 5.4 L5.6 7 L3.6 8.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="6.4"
        y1="9.2"
        x2="10.4"
        y2="9.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
