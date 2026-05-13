import { Outlet, useRouterState } from '@tanstack/react-router';
import { Brand } from './Brand';
import { GitHubLink } from './GitHubLink';
import { SettingsMenu } from './SettingsMenu';
import { TabBar } from './TabBar';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useWorkspaces } from '../workspaces';

/**
 * Persistent application chrome. Renders the top bar with the brand,
 * the active workspace's tab list (when inside one), and the action
 * buttons (GitHub + Settings). Popout routes are mounted outside this
 * layout and have no chrome.
 */
export function AppLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wsSlugMatch = pathname.match(/^\/w\/([^/]+)/);
  const wsSlug = wsSlugMatch?.[1] ?? null;
  const { workspaces } = useWorkspaces();
  const activeWorkspace = wsSlug
    ? workspaces.find((w) => w.slug === wsSlug)
    : null;

  return (
    <div className="app-layout">
      <header className="ws-tabbar">
        <Brand asLink={true} responsive={true} markOnly={!!activeWorkspace} />
        {activeWorkspace && (
          <>
            <WorkspaceSwitcher activeWorkspaceSlug={activeWorkspace.slug} />
            <span className="ws-tabbar-divider" aria-hidden />
            <TabBar
              workspaceId={activeWorkspace.id}
              workspaceSlug={activeWorkspace.slug}
            />
          </>
        )}
        {!activeWorkspace && <span className="ws-tabbar-spacer" />}
        <GitHubLink />
        <SettingsMenu />
      </header>
      <Outlet />
    </div>
  );
}
