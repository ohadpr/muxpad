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

  // Redirect to the first tab when the URL has no tab segment. Preserve
  // search params (e.g. ?debug=1) — otherwise visiting /w/foo from /
  // would drop them on the way to /w/foo/t/bar.
  useEffect(() => {
    if (!workspace) return;
    if (!isExactWorkspacePath) return;
    if (tabs.length === 0) return;
    const first = tabs[0]!;
    const search = Object.fromEntries(
      new URLSearchParams(window.location.search).entries(),
    );
    void navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug, tabSlug: first.slug },
      search,
      replace: true,
    });
  }, [workspace, tabs, isExactWorkspacePath, wsSlug, navigate]);

  // Auto-close the workspace when its last tab is closed. Guard with a
  // ref so this only fires once per delete cycle; reset on wsSlug change
  // so navigating between workspaces doesn't carry a stale "already
  // closed this one" flag across component-instance reuse.
  const autoClosingRef = useRef(false);
  useEffect(() => {
    autoClosingRef.current = false;
  }, [wsSlug]);
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

  // While `workspace` is undefined we render the same loading
  // placeholder regardless of whether the slug genuinely doesn't exist
  // or whether the workspaces list just hasn't loaded yet. Avoids a
  // visible "Workspace not found." flash during cascade-close /
  // navigation, where the workspace momentarily disappears from the
  // refreshed list before the route changes.
  if (!workspace) {
    return <div className="workspace-loading">loading…</div>;
  }

  return <Outlet />;
}
