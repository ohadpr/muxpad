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
  // Show the cross-workspace attention dot on the brand mark when ANY
  // workspace other than the one we're currently viewing has a pane
  // flagging attention. The current workspace's own tabs surface via
  // the tab bar's per-tab dots and the switcher trigger.
  const otherWorkspaceAttention = workspaces.some(
    (w) => w.attention && w.id !== activeWorkspace?.id,
  );

  return (
    <div className="app-layout">
      <header className="ws-tabbar">
        <Brand
          asLink={true}
          responsive={true}
          markOnly={!!activeWorkspace}
          attention={otherWorkspaceAttention}
        />
        {activeWorkspace && (
          <>
            <WorkspaceSwitcher activeWorkspaceSlug={activeWorkspace.slug} />
            {/* `key` forces a remount when the workspace changes so the
                tab list never momentarily shows stale entries from the
                previous workspace. */}
            <TabBar
              key={activeWorkspace.id}
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
