import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from '@tanstack/react-router';
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
import { api, type WorkspaceWithPanes } from '../api';
import { useDocumentTitle } from '../use-document-title';
import { useMediaQuery } from '../use-media-query';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import './workspace.css';

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

export function WorkspaceView() {
  const { slug } = useParams({ from: '/_app/w/$slug' });
  const [workspace, setWorkspace] = useState<WorkspaceWithPanes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileActiveId, setMobileActiveId] = useState<string | null>(null);
  const layoutRef = useRef<Layout>(null);
  const isMobile = useMediaQuery('(max-width: 720px)');
  const { workspaces: allWorkspaces } = useWorkspaces();

  // Title comes from the shared list when available so renames performed in
  // the tab bar update the doc title (and any read of workspace.name in this
  // view) without an explicit refetch here.
  const liveName = allWorkspaces.find((w) => w.slug === slug)?.name ?? workspace?.name;
  useDocumentTitle(liveName ? `muxpad — ${liveName}` : 'muxpad');

  // Sync local workspace.name with the shared list (rename from tab bar etc).
  useEffect(() => {
    if (!workspace) return;
    const updated = allWorkspaces.find((w) => w.id === workspace.id);
    if (updated && updated.name !== workspace.name) {
      setWorkspace((prev) => (prev ? { ...prev, name: updated.name } : prev));
    }
  }, [allWorkspaces, workspace?.id]);

  useEffect(() => {
    let viewedWorkspaceId: string | null = null;
    let cancelled = false;
    let pollTimer: number | null = null;

    const refreshDetail = async (id: string) => {
      try {
        const detail = await api.getWorkspace(id);
        if (cancelled) return;
        // Only fold in fields that should track server state. Crucially we
        // do NOT pull `layout` from the server here — it's locally driven
        // (mosaic onChange updates it before persistLayout flushes), and
        // overwriting it could snap the layout back mid-drag.
        setWorkspace((prev) =>
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
        const list = await api.listWorkspaces();
        const w = list.find((x) => x.slug === slug);
        if (!w) {
          setError('workspace not found');
          return;
        }
        const detail = await api.getWorkspace(w.id);
        if (cancelled) return;
        setWorkspace(detail);
        layoutRef.current = toMosaic(detail.layout);
        viewedWorkspaceId = w.id;
        // Mark seen on enter so any pending attention clears.
        api.markWorkspaceSeen(w.id).then(refreshWorkspaces).catch(() => {});
        // Poll every 5s while the tab is visible so live pane labels
        // (OSC titles, foreground commands) refresh in the background.
        const startPoll = () => {
          if (pollTimer !== null) return;
          pollTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void refreshDetail(w.id);
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
      // Also mark seen on leave. Anything that rang BEL while the user
      // was sitting on this tab counts as seen. Without this, switching
      // away surfaces a dot for attention they were already looking at.
      if (viewedWorkspaceId) {
        api.markWorkspaceSeen(viewedWorkspaceId).then(refreshWorkspaces).catch(() => {});
      }
    };
  }, [slug]);

  const persistLayout = useCallback(
    async (layout: Layout) => {
      if (!workspace) return;
      try {
        await api.patchWorkspace(workspace.id, { layout: fromMosaic(layout) });
      } catch (e) {
        console.error('failed to persist layout', e);
      }
    },
    [workspace],
  );

  // Notify panes that the layout structure changed so they can re-fit. Used
  // by every code path that mutates the layout: mosaic drag-rearrange,
  // splitFromPane, removePaneFromLayout. ResizeObserver alone is unreliable
  // for re-parenting changes — fire across the transition window.
  const notifyLayoutChanged = useCallback(() => {
    const fire = () => window.dispatchEvent(new Event('muxpad:layout-changed'));
    fire();
    requestAnimationFrame(fire);
    window.setTimeout(fire, 200);
    window.setTimeout(fire, 500);
  }, []);

  const onChange = useCallback(
    (layout: Layout) => {
      setWorkspace((prev) => (prev ? { ...prev, layout: fromMosaic(layout) } : prev));
      layoutRef.current = layout;
      void persistLayout(layout);
      notifyLayoutChanged();
    },
    [persistLayout, notifyLayoutChanged],
  );

  const splitFromPane = useCallback(
    async (sourcePaneId: string | null, direction: MosaicDirection) => {
      if (!workspace) return;
      const created = await api.createPane(
        workspace.id,
        sourcePaneId ? { inherit_cwd_from: sourcePaneId } : {},
      );
      const newLayout =
        sourcePaneId == null
          ? created.id
          : splitAtPane(layoutRef.current, sourcePaneId, created.id, direction);
      layoutRef.current = newLayout;
      setWorkspace((prev) =>
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
    [workspace, persistLayout, notifyLayoutChanged],
  );

  const removePaneFromLayout = useCallback(
    async (paneId: string) => {
      const newLayout = removePane(layoutRef.current, paneId);
      layoutRef.current = newLayout;
      setWorkspace((prev) =>
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
      // Hand focus to a remaining pane so the user can keep typing without
      // an extra click. Defer to after the layout commit so the target's
      // term element is still mounted when we ask it to focus.
      const remaining = collectPaneIds(newLayout);
      if (remaining.length > 0) {
        const next = remaining[0]!;
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent('muxpad:focus-pane', { detail: { paneId: next } }),
          );
        }, 0);
      }
    },
    [persistLayout, notifyLayoutChanged],
  );

  const navigate = useNavigate();

  const killPane = useCallback(
    (paneId: string) => removePaneFromLayout(paneId),
    [removePaneFromLayout],
  );

  const closeWorkspace = useCallback(async () => {
    if (!workspace) return;
    try {
      await api.deleteWorkspace(workspace.id);
    } catch (err) {
      console.error('close workspace failed', err);
      return;
    }
    await refreshWorkspaces();
    // Navigate to the next remaining workspace, or back to '/'.
    const remaining = allWorkspaces.filter((w) => w.id !== workspace.id);
    if (remaining.length > 0) {
      const next = remaining[0]!;
      void navigate({ to: '/w/$slug', params: { slug: next.slug } });
    } else {
      void navigate({ to: '/' });
    }
  }, [workspace, allWorkspaces, navigate]);

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
        <Link to="/" className="btn">
          ← Dashboard
        </Link>
      </div>
    );
  if (!workspace) return <div className="workspace-loading">loading…</div>;

  const layout = layoutRef.current;
  const isEmpty = layout == null || layout === '';

  // Number panes by their position in workspace.panes (creation order). Cheap
  // and stable enough for v1 — see punch-list for the "stable ordinal even
  // after delete" follow-up.
  const paneNumber = (paneId: string): number =>
    Math.max(1, workspace.panes.findIndex((p) => p.id === paneId) + 1);

  // OSC title wins when set; otherwise show the foreground command
  // line (path stripped from argv[0]); otherwise "Pane N".
  const paneLabel = (paneId: string): string => {
    const p = workspace.panes.find((x) => x.id === paneId);
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
      if (!workspace) return;
      // On mobile the layout shape doesn't drive visuals (we render one pane
      // at a time); attach the new pane to the active one as a column split
      // so desktop view shows it sensibly when the same workspace is opened
      // there. Inherit the active pane's cwd so 'cd somewhere; +' lands you
      // in the same directory.
      const target = activeId ?? paneIds[paneIds.length - 1];
      const created = await api.createPane(
        workspace.id,
        target ? { inherit_cwd_from: target } : {},
      );
      const newLayout: Layout = target
        ? splitAtPane(layoutRef.current, target, created.id, 'column')
        : created.id;
      layoutRef.current = newLayout;
      setWorkspace((prev) =>
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
      // Pick a sibling to switch to before unmounting the active one.
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
            <p>This workspace has no panes.</p>
            <button className="btn btn-primary" onClick={() => void splitFromPane(null, 'row')}>
              + New pane
            </button>
            <button
              type="button"
              className="workspace-empty-close"
              onClick={() => void closeWorkspace()}
            >
              or close this workspace
            </button>
          </div>
        ) : (
          <Mosaic<string>
            renderTile={(paneId, path) => {
              const label = paneLabel(paneId);
              // renderToolbar must return a native DOM element directly —
              // react-mosaic feeds it to react-dnd's legacy connectDragSource
              // which only accepts host elements, not React components (even
              // forwardRef'd ones).
              return (
                <MosaicWindow<string>
                  path={path}
                  title=""
                  renderToolbar={() => (
                    <div className="pane-chrome">
                      <span className="pane-chrome-title">{label}</span>
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
                        className="pane-chrome-btn"
                        title="Open in new tab"
                        aria-label="Open in new tab"
                        onClick={() => window.open(`/p/${paneId}`, '_blank')}
                      >
                        <SvgPopout />
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

function SvgPopout() {
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        d="M5 2H2v10h10V9 M9 2h3v3 M12 2 7 7"
      />
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
