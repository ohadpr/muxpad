import { useEffect, useRef } from 'react';
import { Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useTabs } from '../tabs';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { api } from '../api';

/**
 * Parent route for `/w/$wsSlug`. Loads the workspace, owns two behaviors:
 *
 *   1. When the URL is just `/w/$wsSlug` (no tab), redirect to the first
 *      tab in the workspace.
 *   2. When the workspace's tab_count drops to 0 (last tab closed),
 *      auto-delete the workspace and navigate home.
 *
 * The Outlet renders the active tab's TabView.
 */
export function WorkspaceLayout() {
  const { wsSlug } = useParams({ from: '/_app/w/$wsSlug' });
  const navigate = useNavigate();
  const { workspaces } = useWorkspaces();
  const workspace = workspaces.find((w) => w.slug === wsSlug);
  const { tabs } = useTabs(workspace?.id ?? '');
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isExactWorkspacePath = pathname === `/w/${wsSlug}`;

  // Redirect to the first tab when the URL has no tab segment.
  useEffect(() => {
    if (!workspace) return;
    if (!isExactWorkspacePath) return;
    if (tabs.length === 0) return;
    const first = tabs[0]!;
    void navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug, tabSlug: first.slug },
      replace: true,
    });
  }, [workspace, tabs, isExactWorkspacePath, wsSlug, navigate]);

  // Auto-close the workspace when its last tab is closed. Guard with a
  // ref so this only fires once per delete cycle.
  const autoClosingRef = useRef(false);
  useEffect(() => {
    if (!workspace) return;
    if (autoClosingRef.current) return;
    if (tabs.length > 0) return;
    // Only act after we've actually loaded the tabs (not the empty
    // initial state). Workspace tab_count being 0 confirms.
    if (workspace.tab_count > 0) return;
    autoClosingRef.current = true;
    (async () => {
      try {
        await api.deleteWorkspace(workspace.id);
      } catch {
        // ignore — workspace may already be gone, or 409 (shouldn't
        // happen since we checked tab_count, but be defensive)
      }
      await refreshWorkspaces();
      void navigate({ to: '/' });
    })();
  }, [workspace, tabs, navigate]);

  if (!workspace) {
    // Either still loading or genuinely missing. If workspaces have
    // loaded and the slug isn't found, render a not-found message.
    if (workspaces.length === 0) {
      return <div className="workspace-loading">loading…</div>;
    }
    return (
      <div className="workspace-error">
        <p>Workspace not found.</p>
      </div>
    );
  }

  return <Outlet />;
}
