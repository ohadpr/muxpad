import { useEffect } from 'react';
import { Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { refreshTabs, useTabs } from '../tabs';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { api } from '../api';

/**
 * Parent route for `/w/$wsSlug`. Two behaviors:
 *
 *   1. When the URL is just `/w/$wsSlug` (no tab), redirect to the first
 *      tab in the workspace.
 *   2. When the workspace has no tabs, render an empty-state UI with
 *      "+ New tab" / "or close this workspace" — workspaces never
 *      disappear implicitly anymore; the user closes them explicitly.
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
  //
  // Defensive: only redirect when the tabs cache and workspaces cache
  // agree on the count. Otherwise we may be mid-mutation (e.g. just
  // deleted the last tab and `tabs` is stale from a not-yet-flushed
  // setState) and would bounce the user right back to the tab they're
  // trying to leave. Both caches refresh on tab.added/tab.removed
  // events, so this guard resolves within one round trip.
  useEffect(() => {
    if (!workspace) return;
    if (!isExactWorkspacePath) return;
    if (tabs.length === 0) return;
    if (tabs.length !== workspace.tab_count) return;
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

  // While `workspace` is undefined we render the same loading
  // placeholder regardless of whether the slug genuinely doesn't exist
  // or whether the workspaces list just hasn't loaded yet. Avoids a
  // visible "Workspace not found." flash during cascade-close /
  // navigation, where the workspace momentarily disappears from the
  // refreshed list before the route changes.
  if (!workspace) {
    return <div className="workspace-loading">loading…</div>;
  }

  // Empty workspace at /w/$wsSlug — either freshly created (CLI / UI)
  // or just drained (last tab closed → TabView navigates here). Either
  // way the user gets the same affordance: populate or close. We never
  // auto-delete workspaces anymore.
  //
  // The tab_count guard prevents the empty UI from flickering during
  // initial load when useTabs() hasn't fetched yet but the workspace
  // actually has tabs. The 'tab.added'/'tab.removed' event handlers in
  // main.tsx call refreshWorkspaces() so tab_count stays current after
  // any tab mutation.
  if (isExactWorkspacePath && tabs.length === 0 && workspace.tab_count === 0) {
    return (
      <div className="workspace-empty">
        <p>{workspace.name} has no tabs yet.</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            try {
              const t = await api.createTab(workspace.id);
              await refreshTabs(workspace.id);
              void navigate({
                to: '/w/$wsSlug/t/$tabSlug',
                params: { wsSlug, tabSlug: t.slug },
                replace: true,
              });
            } catch (err) {
              console.error('createTab failed', err);
            }
          }}
        >
          + New tab
        </button>
        <button
          type="button"
          className="workspace-empty-close"
          onClick={async () => {
            try {
              await api.deleteWorkspace(workspace.id);
            } catch (err) {
              console.error('deleteWorkspace failed', err);
            }
            await refreshWorkspaces();
            void navigate({ to: '/' });
          }}
        >
          or close this workspace
        </button>
      </div>
    );
  }

  return <Outlet />;
}
