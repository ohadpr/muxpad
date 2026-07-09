import { useNavigate, useParams } from '@tanstack/react-router';
import type { DragEvent as ReactDragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mosaic,
  type MosaicDirection,
  type MosaicNode,
  MosaicWindow,
} from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import type { AppUrl, LayoutNode, PaneSpec, Tab } from '@muxpad/shared';
import { spliceLayoutAtTarget } from '@muxpad/shared';
import { type TabWithPanes, api } from '../api';
import { ExternalOpenToasts } from '../components/ExternalOpenToasts';
import { MobileInputBar } from '../components/MobileInputBar';
import { PaneSelector } from '../components/PaneSelector';
import { PaneFaceMenuList, PaneWebSwitch, clampMenuLeft } from '../components/PaneWebSwitch';
// PaneSurfaceSwitch (below) reuses the .pane-web-switch-* menu classes, so
// depend on that stylesheet explicitly rather than relying on the mobile
// PaneWebSwitch mount to pull it into the bundle.
import '../components/PaneWebSwitch.css';
import { ShellPaneBody } from '../components/ShellPaneBody';
import { UrlPane } from '../components/UrlPane';
import { SvgClose } from '../components/icons';
import { subscribe, subscribeReconnect } from '../events';
import { handoffToAgent } from '../lib/agent-handoff';
import { getLastPaneId, setLastPaneId, setLastTabSlug } from '../lib/last-visited';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import { pushUndo } from '../lib/move-undo-store';
import { usePaneFace } from '../lib/pane-face';
import { setTabViewMode, useTabViewMode } from '../lib/tab-view-mode';
import { refreshTabs, useTabs } from '../tabs';
import { useMediaQuery } from '../use-media-query';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';

// What a "+" creates: a plain terminal pane or a chat-native agent pane.
type NewPaneKind = 'terminal' | 'agent';
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

/** Walk the binary tree, returning all pane ids in tree order. */
function collectPaneIds(layout: Layout): string[] {
  if (layout == null) return [];
  if (typeof layout === 'string') return [layout];
  return [...collectPaneIds(layout.first as Layout), ...collectPaneIds(layout.second as Layout)];
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

const PANE_DRAG_MIME = 'application/x-muxpad-pane-id';

export interface TabViewProps {
  /** Stable slug for this instance — one TabView per tab in WorkspaceLayout. */
  tabSlug: string;
  /** False while the tab is mounted but hidden during a tab switch. */
  isActive: boolean;
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
  // is also dispatched by the row-2 "+" rendered next to PaneSelector
  // — one listener, two emitters.
  useEffect(() => {
    const onAddPane = () => addPaneRef.current?.();
    window.addEventListener('muxpad:add-pane', onAddPane);
    return () => window.removeEventListener('muxpad:add-pane', onAddPane);
  }, []);

  // "Continue in Agent tab" from a TUI pane's face menu: orchestrate the
  // one-way handoff (TUI writes its context file and retires itself; a fresh
  // agent tab absorbs it — lib/agent-handoff.ts). Lives here because the
  // menu knows only paneId; this component holds the workspace + pane cwd
  // and can navigate. The async flow survives the navigation-triggered
  // remount — it's just fetches in a closure.
  useEffect(() => {
    const onHandoff = (e: Event) => {
      const d = (e as CustomEvent<{ paneId?: string }>).detail;
      const p = d?.paneId ? tab?.panes.find((x) => x.id === d.paneId) : undefined;
      if (!p || !workspace) return;
      void handoffToAgent({
        paneId: p.id,
        workspaceId: workspace.id,
        cwd: p.cwd,
        // Retire the whole tab when this is its only pane — a bare
        // pane-delete would leave an empty tab shell in the sidebar.
        closeCmd:
          tab && tab.panes.length === 1
            ? `muxpad tab delete ${tab.id}`
            : `muxpad pane delete ${p.id}`,
        onTabCreated: (tabSlug) => {
          // Refresh the tabs list FIRST — navigating to a slug the client
          // hasn't loaded yet trips the dead-tab redirect and bounces back.
          void refreshTabs(workspace.id)
            .catch(() => {})
            .then(() => navigate({ to: '/w/$wsSlug/t/$tabSlug', params: { wsSlug, tabSlug } }));
        },
      }).then((res) => {
        if (!res.ok && res.error) window.alert(res.error);
      });
    };
    window.addEventListener('muxpad:handoff-to-agent', onHandoff);
    return () => window.removeEventListener('muxpad:handoff-to-agent', onHandoff);
  }, [tab, workspace, navigate, wsSlug]);

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
  useEffect(() => {
    if (!tab || !workspace || !isActive) return;
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
  }, [tab?.id, mobileActiveResolved, isMobile, workspace?.id, isActive]);

  // Title pulls the live name from the shared tabs list so renames in
  // the tab bar update the document title without a refetch here.
  const liveName = allTabs.find((t) => t.slug === tabSlug)?.name ?? tab?.name;
  const liveWorkspaceName = workspace?.name;
  const documentTitle =
    liveWorkspaceName && liveName
      ? `${liveWorkspaceName} ⋅ ${liveName}`
      : (liveName ?? liveWorkspaceName ?? 'muxpad');

  // In single-pane views (mobile or desktop 'tabbed') the browser tab is a
  // window onto ONE pane at a time, so we can meaningfully say "the visible
  // pane is working" by animating a spinner into the tab title. Split view
  // shows every pane at once — there's no single active pane to represent, so
  // we leave the title clean there.
  const activePaneBusy = (() => {
    if (!singlePane || !tab) return false;
    const ids = tab.panes.map((p) => p.id);
    let activeId: string | null = null;
    if (mobileActiveId && ids.includes(mobileActiveId)) activeId = mobileActiveId;
    else {
      const stored = getLastPaneId(tab.id);
      activeId = stored && ids.includes(stored) ? stored : (ids[0] ?? null);
    }
    return tab.panes.find((p) => p.id === activeId)?.busy ?? false;
  })();

  useEffect(() => {
    if (!isActive) return;
    const previous = document.title;
    if (!activePaneBusy) {
      document.title = documentTitle;
      return () => {
        document.title = previous;
      };
    }
    // Braille spinner cycled via the title itself — the only way to show a
    // live loading indicator in a browser tab (favicons can't animate without
    // canvas hackery, and the emoji/text of the title is all we control).
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const tick = () => {
      document.title = `${frames[i]} ${documentTitle}`;
      i = (i + 1) % frames.length;
    };
    tick();
    const id = window.setInterval(tick, 120);
    return () => {
      window.clearInterval(id);
      document.title = previous;
    };
  }, [isActive, documentTitle, activePaneBusy]);

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
        const tabs = await api.listTabs(workspace.id);
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
        // before the user could see which pane was BELing in the
        // PaneSelector dropdown. The per-pane / per-mode seen happens
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
        await api.patchTab(tab.id, { layout: fromMosaic(layout) });
      } catch (e) {
        console.error('failed to persist layout', e);
      } finally {
        pendingLayoutWrites.current -= 1;
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
    async (
      sourcePaneId: string | null,
      direction: MosaicDirection,
      kind: NewPaneKind = 'terminal',
    ) => {
      if (!tab) return;
      const created = await api.createPane(tab.id, {
        ...(sourcePaneId ? { inherit_cwd_from: sourcePaneId } : {}),
        // Agent pane: a chat-native Claude session (`muxpad agent` runs in
        // the pty underneath; the face lands on chat immediately).
        ...(kind === 'agent' ? { startup_cmd: 'muxpad agent', face: 'chat' as const } : {}),
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
        // snapshot may predate it and would revert an optimistic split.
        const applyLayout = pendingLayoutWrites.current === 0;
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
          void navigate({ to: '/w/$wsSlug', params: { wsSlug } });
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
      const created = await api.createPane(tab.id, target ? { inherit_cwd_from: target } : {});
      const newLayout: Layout = target
        ? splitAtPane(layoutRef.current, target, created.id, 'column')
        : created.id;
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

    const closeActivePane = () => {
      if (!activeId) return;
      const idx = paneIds.indexOf(activeId);
      const next = paneIds[idx + 1] ?? paneIds[idx - 1] ?? null;
      setMobileActiveId(next);
      void killPane(activeId);
    };

    return (
      <div className="workspace-root workspace-mobile">
        {/* Pane row only renders when there's more than one pane to
            choose between. The "+" inside it dispatches muxpad:add-pane;
            TabView listens at the window level and forwards to the
            mobile branch's addPane closure. */}
        {/* Mobile pane header. With >1 pane it's a single row: chooser
            (truncates), the terminal/web switch, then add + close — instead of
            wasting a second line on the switch. With one pane there's no
            chooser, so the switch gets its own slim bar (which collapses to
            nothing when there's no web view to offer). The switch sits at the
            top either way so its dropdown opens downward into the pane area. */}
        {(() => {
          const ap = activeId ? tab.panes.find((p) => p.id === activeId) : undefined;
          const webSwitch =
            ap && ap.kind === 'shell' ? (
              <PaneWebSwitch
                paneId={ap.id}
                appUrls={ap.app_urls ?? []}
                startupCmd={ap.startup_cmd}
              />
            ) : null;
          if (paneIds.length > 1) {
            return (
              <nav className="mobile-tab-strip" aria-label="Panes">
                <PaneSelector
                  paneIds={paneIds}
                  activeId={activeId}
                  paneLabel={paneLabel}
                  paneAttention={(id) => tab.panes.find((p) => p.id === id)?.attention ?? false}
                  onSelect={setMobileActiveId}
                />
                {webSwitch && <div className="mobile-strip-webswitch">{webSwitch}</div>}
                <button
                  type="button"
                  className="ws-tab-add"
                  onClick={() => window.dispatchEvent(new CustomEvent('muxpad:add-pane'))}
                  title="New pane"
                  aria-label="New pane"
                >
                  +
                </button>
                {activeId && (
                  <button
                    type="button"
                    className="mobile-tab-close"
                    onClick={closeActivePane}
                    title="Close active pane"
                    aria-label="Close active pane"
                  >
                    <SvgClose size={12} />
                  </button>
                )}
              </nav>
            );
          }
          return webSwitch ? <div className="mobile-web-switch-bar">{webSwitch}</div> : null;
        })()}
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

    const addPane = async (kind: NewPaneKind = 'terminal') => {
      const target = activeId ?? paneIds[paneIds.length - 1];
      const created = await api.createPane(tab.id, {
        ...(target ? { inherit_cwd_from: target } : {}),
        ...(kind === 'agent' ? { startup_cmd: 'muxpad agent', face: 'chat' as const } : {}),
      });
      const newLayout: Layout = target
        ? splitAtPane(layoutRef.current, target, created.id, 'row')
        : created.id;
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
                        <span className="desktop-tab-label">{paneLabel(paneId)}</span>
                      </button>
                      {/* The face switch lives ON the active tab — it
                          describes THIS pane's view (terminal/chat/web), so
                          parking it at the strip's edge read as global
                          chrome, disconnected from its subject. Compact
                          (icon + caret): the tab already carries the name. */}
                      {isActiveTab && p?.kind === 'shell' ? (
                        <PaneWebSwitch
                          paneId={p.id}
                          appUrls={p.app_urls ?? []}
                          startupCmd={p.startup_cmd}
                          compact
                        />
                      ) : null}
                      {/* Trailing slot: the status glyph and the close × share
                          ONE fixed-width box — the × fades in over the status on
                          hover/active. So the label's available width is the
                          same whether or not a status shows, and the two never
                          collide even at the min tab width. Status priority
                          mirrors the navigator: WORKING (spinner) → WANTS YOU
                          (dot) → idle. Busy is hidden on the active tab (its
                          output is right there); the dot self-clears on view. */}
                      <span className="desktop-tab-trailing">
                        {!isActiveTab && p?.busy ? (
                          <span className="desktop-tab-busy" aria-hidden="true" title="Working…">
                            <SvgSpinner />
                          </span>
                        ) : p?.attention ? (
                          <span className="badge-dot -inline" aria-label="needs attention" />
                        ) : null}
                        <button
                          type="button"
                          className="desktop-tab-close"
                          title="Close pane"
                          aria-label="Close pane"
                          onClick={() => closePane(paneId)}
                        >
                          <SvgClose size={11} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              );
            })}
            {/* Two direct labeled choices — same wording as the sidebar's
                new-tab row, so creation reads identically everywhere (bare
                glyphs were too cryptic). */}
            <button
              type="button"
              className="desktop-tab-add"
              title="New terminal pane"
              onClick={() => void addPane('terminal')}
            >
              + Terminal
            </button>
            <button
              type="button"
              className="desktop-tab-add"
              title="New agent pane (chat-native Claude session)"
              onClick={() => void addPane('agent')}
            >
              ✳ Agent
            </button>
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
              + Terminal
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void splitFromPane(null, 'row', 'agent')}
            >
              ✳ Agent
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
                        <UrlPaneTitle
                          paneId={paneId}
                          url={tilePane?.url ?? null}
                          onKindToggled={onKindToggled}
                        />
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

  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    // The menu is position:fixed (measured from the trigger) — coords go
    // stale on scroll/resize, so just close.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
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
        {onChat ? (
          <span className="pane-web-switch-glyph" aria-hidden="true">
            ✳
          </span>
        ) : (
          <Icon />
        )}
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

/**
 * Pane chrome title for URL panes. URL renders as an anchor whose
 * native cmd/ctrl/shift/middle-click opens in a new tab/window. Double-click
 * swaps to an input for editing (Enter saves via PATCH, Esc/blur cancels).
 * Plain click is preventDefault'd so it doesn't navigate the whole window.
 *
 * Leftmost: a PaneSurfaceSwitch that doubles as the loading spinner. When `url`
 * is null (the pane was just type-switched from shell) we auto-enter edit
 * mode with an empty input focused, so the user can type a URL immediately.
 */
function UrlPaneTitle({
  paneId,
  url,
  onKindToggled,
}: {
  paneId: string;
  url: string | null;
  onKindToggled: (updated: PaneSpec) => void;
}) {
  // When url is null, default to editing — there's nothing to display.
  const [editing, setEditing] = useState(url == null);
  const [draft, setDraft] = useState(url ?? '');
  const [loading, setLoading] = useState(url != null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(url ?? '');
    if (url == null) setEditing(true);
  }, [url]);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Sync with UrlPane's load-state events for our paneId.
  useEffect(() => {
    const onLoading = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.paneId !== paneId) return;
      setLoading(!!detail.loading);
    };
    window.addEventListener('muxpad:url-pane-loading', onLoading);
    return () => window.removeEventListener('muxpad:url-pane-loading', onLoading);
  }, [paneId]);

  const commit = async () => {
    const next = normalizeUrl(draft);
    if (!next || next === url) {
      // No-op submission: only exit edit mode if there's an existing url
      // to show. With url=null we'd render nothing — keep editing so the
      // input stays visible for another try.
      if (url != null) setEditing(false);
      setDraft(url ?? '');
      return;
    }
    setEditing(false);
    try {
      await api.patchPane(paneId, { url: next });
      // Show loading immediately — without this the spinner doesn't fire
      // until the pane.updated event arrives via /ws/events and the new
      // url prop reaches UrlPane, by which time the iframe may already
      // be partway through its load. Setting it here means the spinner
      // covers the full "user pressed enter → iframe done" window.
      setLoading(true);
    } catch (e) {
      console.error('patchPane failed', e);
      setDraft(url ?? '');
    }
  };

  const cancel = () => {
    setDraft(url ?? '');
    // url=null → no URL to fall back to displaying. Stay in edit mode so
    // the chrome doesn't render an empty link.
    if (url != null) setEditing(false);
  };

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
        currentKind="url"
        loading={loading}
        onSelect={handleSwitch}
      />
      {editing ? (
        <input
          ref={inputRef}
          className="pane-chrome-title-input"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={url == null ? 'https://…' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            else if (e.key === 'Escape') cancel();
          }}
          onBlur={cancel}
          // Don't let the editing area act as a mosaic drag handle.
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <a
          href={url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="pane-chrome-title-link"
          title={url ? `${url} — double-click to edit` : 'Double-click to edit'}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            setEditing(true);
          }}
        >
          <span className="pane-chrome-title">{url}</span>
        </a>
      )}
    </>
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

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bare hostname/path → assume https.
  return `https://${trimmed}`;
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

/**
 * Busy spinner for a pane header — a partial ring in `currentColor`, spun by
 * CSS (.desktop-tab-busy). Mirrors the navigator's SvgSpinner so "working"
 * reads the same in the tab strip as in the sidebar.
 */
function SvgSpinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        opacity="0.25"
      />
      <path
        d="M8 2 a6 6 0 0 1 6 6"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
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
