import { Outlet, useRouterState } from '@tanstack/react-router';
import { Brand } from './Brand';
import { SettingsMenu } from './SettingsMenu';
import { TabBar } from './TabBar';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useWorkspaces } from '../workspaces';

// Cross-workspace attention is surfaced exclusively on the WorkspaceSwitcher
// trigger. The brand mark used to carry a duplicate dot on the same
// condition, which read as two separate signals — removed to keep one
// canonical place to look.

const REPO_URL = 'https://github.com/ohadpr/muxpad';

/**
 * Persistent application chrome. Renders the top bar with the brand,
 * the active workspace's tab list (when inside one), and the Settings
 * menu. The right-side "muxpad <build>" wordmark doubles as the GitHub
 * repo link. Popout routes are mounted outside this layout.
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
        <Brand
          asLink={true}
          responsive={true}
          markOnly={!!activeWorkspace}
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
        <a
          className="brand-text-side"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={`muxpad — build ${__MUXPAD_VERSION__}`}
        >
          muxpad <span className="brand-text-side-version">{__MUXPAD_VERSION__}</span>
        </a>
        <SettingsMenu />
      </header>
      <Outlet />
    </div>
  );
}
