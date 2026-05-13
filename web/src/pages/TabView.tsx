import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import {
  Mosaic,
  MosaicWindow,
  type MosaicNode,
  type MosaicDirection,
} from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import { XtermPane } from '../components/XtermPane';
import { PaneSelector } from '../components/PaneSelector';
import type { LayoutNode } from '@muxpad/shared';
import { api, type TabWithPanes } from '../api';
import { useDocumentTitle } from '../use-document-title';
import { useMediaQuery } from '../use-media-query';
import { refreshTabs, useTabs } from '../tabs';
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
    ...(layout.splitPercentage !== undefined
      ? { splitPercentage: layout.splitPercentage }
      : {}),
    first: fromMosaic(layout.first),
    second: fromMosaic(layout.second),
  };
}

/** Replace `targetId` in the tree with a split containing the target + new pane. */
function splitAtPane(
  layout: Layout,
  targetId: string,
  newId: string,
  direction: MosaicDirection,
): Layout {
  if (layout == null) return newId;
  if (typeof layout === 'string') {
    return layout === targetId
      ? { direction, first: targetId, second: newId }
      : layout;
  }
  return {
    ...layout,
    first: (splitAtPane(layout.first, targetId, newId, direction) ?? '') as MosaicNode<string>,
    second: (splitAtPane(layout.second, targetId, newId, direction) ?? '') as MosaicNode<string>,
  };
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
  return [
    ...collectPaneIds(layout.first as Layout),
    ...collectPaneIds(layout.second as Layout),
  ];
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

  // Title pulls the live name from the shared tabs list so renames in
  // the tab bar update the document title without a refetch here.
  const liveName = allTabs.find((t) => t.slug === tabSlug)?.name ?? tab?.name;
  useDocumentTitle(liveName ? `muxpad — ${liveName}` : 'muxpad');

  // Keep local tab.name in sync with the shared list.
  useEffect(() => {
    if (!tab) return;
    const updated = allTabs.find((t) => t.id === tab.id);
    if (updated && updated.name !== tab.name) {
      setTab((prev) => (prev ? { ...prev, name: updated.name } : prev));
    }
  }, [allTabs, tab?.id]);

  // Load the tab by slug + poll detail every 5s while visible so pane
  // labels (OSC titles, fg commands) refresh in the background.
  useEffect(() => {
    if (!workspace) return;
    // Navigated to a new tab — reset the cascade-close placeholder so
    // the new tab renders normally instead of stuck on "loading…".
    setClosingTab(false);
    setTab(null);
    let viewedTabId: string | null = null;
    let cancelled = false;
    let pollTimer: number | null = null;

    const refreshDetail = async (id: string) => {
      try {
        const detail = await api.getTab(id);
        if (cancelled) return;
        // Only fold in fields that should track server state — never
        // `layout`, which is locally driven by mosaic onChange and
        // overwriting it could snap the layout back mid-drag.
        setTab((prev) =>
          prev
            ? {
                ...prev,
                panes: detail.panes,
                name: detail.name,
                slug: detail.slug,
                attention: detail.attention,
                updated_at: detail.updated_at,
              }
            : detail,
        );
      } catch {
        // ignore — next poll will retry
      }
    };

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
        api.markTabSeen(found.id).then(() => refreshTabs(workspace.id)).catch(() => {});
        const startPoll = () => {
          if (pollTimer !== null) return;
          pollTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void refreshDetail(found.id);
          }, 5000);
        };
        startPoll();
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (viewedTabId) {
        api
          .markTabSeen(viewedTabId)
          .then(() => refreshTabs(workspace.id))
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
   * If this was the last tab in the workspace, also delete the workspace
   * and navigate home. (WorkspaceLayout has its own auto-close-empty
   * effect as a safety net for cross-device mutations, but doing the
   * cascade explicitly here avoids relying on stale useWorkspaces state
   * to fire it.)
   */
  const closeTab = useCallback(async () => {
    if (!tab || !workspace) return;
    setClosingTab(true);
    const isLastTab = allTabs.filter((t) => t.id !== tab.id).length === 0;
    try {
      await api.deleteTab(tab.id);
    } catch (err) {
      console.error('close tab failed', err);
      setClosingTab(false);
      return;
    }
    if (isLastTab) {
      try {
        await api.deleteWorkspace(workspace.id);
      } catch (err) {
        console.error('delete workspace failed', err);
      }
      await refreshWorkspaces();
      void navigate({ to: '/' });
      return;
    }
    // Pick the neighbor: right if there is one, else left. Matches
    // the convention browsers use when closing the active tab.
    const myIdx = allTabs.findIndex((t) => t.id === tab.id);
    const next = allTabs[myIdx + 1] ?? allTabs[myIdx - 1];
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
          window.dispatchEvent(
            new CustomEvent('muxpad:focus-pane', { detail: { paneId: next } }),
          );
        }, 0);
      } else {
        // Last pane in this tab is gone → cascade-close the tab.
        // WorkspaceLayout in turn auto-closes the workspace if this
        // was the workspace's last tab.
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
    Math.max(1, tab.panes.findIndex((p) => p.id === paneId) + 1);

  const paneLabel = (paneId: string): string => {
    const p = tab.panes.find((x) => x.id === paneId);
    const title = p?.title?.trim();
    if (title) return title;
    const cmd = p?.foreground_cmd?.trim();
    if (cmd) return cmd;
    return `Pane ${paneNumber(paneId)}`;
  };

  if (isMobile && !isEmpty) {
    const paneIds = collectPaneIds(layout);
    const activeId =
      mobileActiveId && paneIds.includes(mobileActiveId)
        ? mobileActiveId
        : (paneIds[0] ?? null);

    const addPane = async () => {
      if (!tab) return;
      const target = activeId ?? paneIds[paneIds.length - 1];
      const created = await api.createPane(
        tab.id,
        target ? { inherit_cwd_from: target } : {},
      );
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
          {activeId && (
            <XtermPane
              key={activeId}
              paneId={activeId}
              onExit={() => onPaneExited(activeId)}
            />
          )}
        </main>
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
            <button
              type="button"
              className="workspace-empty-close"
              onClick={() => void closeTab()}
            >
              or close this tab
            </button>
          </div>
        ) : (
          <Mosaic<string>
            renderTile={(paneId, path) => {
              const label = paneLabel(paneId);
              return (
                <MosaicWindow<string>
                  path={path}
                  title=""
                  renderToolbar={() => (
                    <div className="pane-chrome">
                      {/* Title is an anchor to the pane's popout URL.
                          Plain click does nothing special (preventDefault
                          so it doesn't navigate the whole window);
                          Cmd/Ctrl/middle-click falls through to the
                          browser's native "open in new tab" behavior. */}
                      <a
                        href={`/p/${paneId}`}
                        className="pane-chrome-title-link"
                        onClick={(e) => {
                          if (
                            e.metaKey ||
                            e.ctrlKey ||
                            e.shiftKey ||
                            e.altKey ||
                            e.button !== 0
                          )
                            return;
                          e.preventDefault();
                        }}
                        title="Cmd/Ctrl-click to open in new tab"
                      >
                        <span className="pane-chrome-title">{label}</span>
                      </a>
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
                  <XtermPane paneId={paneId} onExit={() => onPaneExited(paneId)} />
                </MosaicWindow>
              );
            }}
            value={layout}
            onChange={onChange}
            blueprintNamespace="bp4"
          />
        )}
      </main>
    </div>
  );
}

function SvgSplitRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="1" y="2" width="5" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="2" width="5" height="10" rx="1" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function SvgSplitDown() {
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2" y="1" width="10" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="8" width="10" height="5" rx="1" fill="currentColor" opacity="0.4" />
    </svg>
  );
}


function SvgClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 12 12" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        d="M3 3l6 6M9 3l-6 6"
      />
    </svg>
  );
}
