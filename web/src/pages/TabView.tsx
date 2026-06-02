import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mosaic,
  type MosaicDirection,
  type MosaicNode,
  MosaicWindow,
} from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import type { LayoutNode, PaneSpec } from '@muxpad/shared';
import { spliceLayoutAtTarget } from '@muxpad/shared';
import { type TabWithPanes, api } from '../api';
import { ExternalOpenToasts } from '../components/ExternalOpenToasts';
import { MobileInputBar } from '../components/MobileInputBar';
import { PaneSelector } from '../components/PaneSelector';
import { UrlPane } from '../components/UrlPane';
import { XtermPane } from '../components/XtermPane';
import { subscribe, subscribeReconnect } from '../events';
import { refreshTabs, useTabs } from '../tabs';
import { useDocumentTitle } from '../use-document-title';
import { useMediaQuery } from '../use-media-query';
import { getLastPaneId, setLastPaneId, setLastTabSlug } from '../lib/last-visited';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
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

export function TabView() {
  const { wsSlug, tabSlug } = useParams({ from: '/_app/w/$wsSlug/t/$tabSlug' });
  const navigate = useNavigate();
  const { workspaces } = useWorkspaces();
  const workspace = workspaces.find((w) => w.slug === wsSlug);
  const { tabs: allTabs } = useTabs(workspace?.id ?? '');

  const [tab, setTab] = useState<TabWithPanes | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True from the moment we know the tab is about to disappear (cascade
  // close, explicit close-tab CTA, …) until we actually navigate away.
  // Used to suppress the empty-tab state flicker that would otherwise
  // render for a frame between "last pane removed locally" and
  // "navigate to next route".
  const [closingTab, setClosingTab] = useState(false);
  const [mobileActiveId, setMobileActiveId] = useState<string | null>(null);
  const layoutRef = useRef<Layout>(null);
  const isMobile = useMediaQuery('(max-width: 720px)');

  // Remember which tab we're on so the next visit to /w/$wsSlug
  // restores it (see WorkspaceLayout).
  useEffect(() => {
    setLastTabSlug(wsSlug, tabSlug);
  }, [wsSlug, tabSlug]);

  // Persist the active pane per tab whenever it changes (mobile only —
  // desktop shows all panes via mosaic, no "active" concept).
  useEffect(() => {
    if (!isMobile || !tab || !mobileActiveId) return;
    setLastPaneId(tab.id, mobileActiveId);
  }, [isMobile, tab, mobileActiveId]);

  // Title pulls the live name from the shared tabs list so renames in
  // the tab bar update the document title without a refetch here.
  const liveName = allTabs.find((t) => t.slug === tabSlug)?.name ?? tab?.name;
  const liveWorkspaceName = workspace?.name;
  useDocumentTitle(
    liveWorkspaceName && liveName
      ? `${liveWorkspaceName} ⋅ ${liveName}`
      : (liveName ?? liveWorkspaceName ?? 'muxpad'),
  );

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

  // Load the tab by slug once on mount/tab-change. Title / fg / attention
  // and structural changes (pane add/remove, layout updates, kind flips)
  // arrive via /ws/events — see the subscribe() effect below and the
  // app-level handlers in main.tsx. There is no 5s poll anymore.
  useEffect(() => {
    if (!workspace) return;
    // Navigated to a new tab — reset the cascade-close placeholder so
    // the new tab renders normally instead of stuck on "loading…".
    setClosingTab(false);
    setTab(null);
    let viewedTabId: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const tabs = await api.listTabs(workspace.id);
        const found = tabs.find((t) => t.slug === tabSlug);
        if (!found) {
          setError('tab not found');
          return;
        }
        const detail = await api.getTab(found.id);
        if (cancelled) return;
        setTab(detail);
        layoutRef.current = toMosaic(detail.layout);
        viewedTabId = found.id;
        // refreshWorkspaces too so the favicon and workspace-switcher dot
        // (both derived from the workspace-level attention rollup) update
        // without waiting for the next 5s workspace poll.
        api
          .markTabSeen(found.id)
          .then(() => Promise.all([refreshTabs(workspace.id), refreshWorkspaces()]))
          .catch(() => {});
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
  }, [workspace?.id, tabSlug]);

  const persistLayout = useCallback(
    async (layout: Layout) => {
      if (!tab) return;
      try {
        await api.patchTab(tab.id, { layout: fromMosaic(layout) });
      } catch (e) {
        console.error('failed to persist layout', e);
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
      const created = await api.createPane(
        tab.id,
        sourcePaneId ? { inherit_cwd_from: sourcePaneId } : {},
      );
      const newLayout =
        sourcePaneId == null
          ? created.id
          : splitAtPane(layoutRef.current, sourcePaneId, created.id, direction);
      layoutRef.current = newLayout;
      setTab((prev) =>
        prev
          ? {
              ...prev,
              layout: fromMosaic(newLayout),
              panes: [...prev.panes, created],
            }
          : prev,
      );
      await persistLayout(newLayout);
      notifyLayoutChanged();
    },
    [tab, persistLayout, notifyLayoutChanged],
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
   * (see TypeSwitcher → patchPane callers), so we can splice it in now
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
                  };
                }),
              }
            : prev,
        );
      } else if (e.type === 'tab.updated' && e.tab.id === tabId) {
        setTab((prev) =>
          prev
            ? {
                ...prev,
                name: e.tab.name,
                slug: e.tab.slug,
                layout: e.tab.layout,
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
        layoutRef.current = toMosaic(e.tab.layout);
      } else if (e.type === 'tab.removed' && e.tab_id === tabId) {
        setClosingTab(true);
        void navigate({ to: '/w/$wsSlug', params: { wsSlug } });
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
          setTab((prev) => (prev && prev.id === tabId ? { ...prev, ...detail } : prev));
          layoutRef.current = toMosaic(detail.layout);
        })
        .catch(() => {
          // Tab may have been deleted during the disconnect window — the
          // subscribe() effect's tab.removed handler is the safety net for
          // that path. Swallow here.
        });
    });
  }, [tab?.id]);

  if (error)
    return (
      <div className="workspace-error">
        <p>{error}</p>
      </div>
    );
  if (!tab) return <div className="workspace-loading">loading…</div>;
  // While the cascade-close is in flight, render nothing instead of the
  // empty-tab CTA. The closeTab nav fires shortly after; this avoids a
  // brief flicker between "last pane gone" and "route changes".
  if (closingTab) return <div className="workspace-loading">loading…</div>;

  const layout = layoutRef.current;
  const isEmpty = layout == null || layout === '';

  const paneNumber = (paneId: string): number =>
    tab.panes.findIndex((p) => p.id === paneId) + 1;

  const paneLabel = (paneId: string): string => {
    const p = tab.panes.find((x) => x.id === paneId);
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
              panes: [...prev.panes, created],
            }
          : prev,
      );
      setMobileActiveId(created.id);
      await persistLayout(newLayout);
      notifyLayoutChanged();
    };

    const closeActivePane = () => {
      if (!activeId) return;
      const idx = paneIds.indexOf(activeId);
      const next = paneIds[idx + 1] ?? paneIds[idx - 1] ?? null;
      setMobileActiveId(next);
      void killPane(activeId);
    };

    return (
      <div className="workspace-root workspace-mobile">
        <nav className="mobile-tab-strip" aria-label="Panes">
          <PaneSelector
            paneIds={paneIds}
            activeId={activeId}
            paneLabel={paneLabel}
            onSelect={setMobileActiveId}
            onAdd={() => void addPane()}
          />
          {activeId && (
            <button
              type="button"
              className="mobile-tab-close"
              onClick={closeActivePane}
              title="Close active pane"
              aria-label="Close active pane"
            >
              <SvgClose />
            </button>
          )}
        </nav>
        <main className="workspace-body workspace-body-mobile">
          {activeId &&
            (() => {
              const pane = tab.panes.find((p) => p.id === activeId);
              if (!pane) return null;
              return <PaneBody key={activeId} pane={pane} onExit={() => onPaneExited(activeId)} />;
            })()}
        </main>
        <MobileInputBar
          paneId={activeId}
          paneKind={tab.panes.find((p) => p.id === activeId)?.kind ?? null}
        />
      </div>
    );
  }

  return (
    <div className="workspace-root">
      <main className="workspace-body">
        {isEmpty ? (
          <div className="workspace-empty">
            <p>This tab has no panes.</p>
            <button className="btn btn-primary" onClick={() => void splitFromPane(null, 'row')}>
              + New pane
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
                      <button
                        className="pane-chrome-btn pane-chrome-close"
                        title="Close pane"
                        aria-label="Close pane"
                        onClick={() => void killPane(paneId)}
                      >
                        <SvgClose />
                      </button>
                    </div>
                  )}
                >
                  {tilePane && <PaneBody pane={tilePane} onExit={() => onPaneExited(paneId)} />}
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
function PaneBody({ pane, onExit }: { pane: PaneSpec; onExit: () => void }) {
  if (pane.kind === 'url') {
    return <UrlPane paneId={pane.id} url={pane.url} />;
  }
  return <XtermPane paneId={pane.id} onExit={onExit} />;
}

/**
 * Leftmost chrome button that opens a popover with the available pane
 * types. Click outside or Esc closes. Selecting the current type is a
 * no-op (the menu item is disabled). Doubles as the URL pane loading
 * indicator via the optional `loading` prop, which overlays a spinner
 * ring on the icon.
 */
function TypeSwitcher({
  currentKind,
  onSelect,
  loading,
}: {
  currentKind: 'shell' | 'url';
  onSelect: (next: 'shell' | 'url') => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Icon = currentKind === 'url' ? SvgGlobe : SvgTerminal;
  return (
    <div className="pane-chrome-typeswitch-wrap" ref={wrapperRef}>
      <button
        type="button"
        className={`pane-chrome-typeswitch pane-chrome-typeswitch-${currentKind}${
          loading ? ' pane-chrome-typeswitch-loading' : ''
        }`}
        title="Switch pane type"
        aria-label="Switch pane type"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Icon />
        {loading && <span className="pane-chrome-typeswitch-spinner" aria-hidden="true" />}
      </button>
      {open && (
        <div
          className="pane-chrome-typeswitch-menu"
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="pane-chrome-typeswitch-menu-item"
            disabled={currentKind === 'shell'}
            onClick={() => {
              setOpen(false);
              if (currentKind !== 'shell') onSelect('shell');
            }}
          >
            <SvgTerminal />
            <span>Terminal</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pane-chrome-typeswitch-menu-item"
            disabled={currentKind === 'url'}
            onClick={() => {
              setOpen(false);
              if (currentKind !== 'url') onSelect('url');
            }}
          >
            <SvgGlobe />
            <span>Web</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Pane chrome title for URL panes. URL renders as an anchor whose
 * native cmd/ctrl/shift/middle-click opens in a new tab/window. Double-click
 * swaps to an input for editing (Enter saves via PATCH, Esc/blur cancels).
 * Plain click is preventDefault'd so it doesn't navigate the whole window.
 *
 * Leftmost: a TypeSwitcher that doubles as the loading spinner. When `url`
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
      <TypeSwitcher currentKind="url" loading={loading} onSelect={handleSwitch} />
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
  onKindToggled,
}: {
  paneId: string;
  label: string;
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
      <TypeSwitcher currentKind="shell" onSelect={handleSwitch} />
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

function SvgClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 12 12" aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}
