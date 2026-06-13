import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { MOBILE_BREAKPOINT } from '../lib/mobile-layout';
import { useSettings } from '../settings';
import { useMediaQuery } from '../use-media-query';
import { useWindowAttention } from '../use-window-attention';
import { useWorkspaces } from '../workspaces';
import { Brand } from './Brand';
import { MobileNavSwitcher } from './MobileNavSwitcher';
import { NavTree } from './NavTree';
import { SettingsMenu } from './SettingsMenu';
import { TabBar } from './TabBar';
import { WorkspaceShell } from './WorkspaceLayout';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

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
 *
 * Navigator placement (desktop) follows settings.navLayout:
 *   'top'     — WorkspaceSwitcher + TabBar in the chrome bar (classic).
 *   'sidebar' — a persistent left NavTree replaces both; the top bar
 *               slims down to brand + build + settings.
 * Mobile always gets the MobileNavSwitcher breadcrumb + bottom sheet.
 */
export function AppLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wsSlugMatch = pathname.match(/^\/w\/([^/]+)/);
  const wsSlug = wsSlugMatch?.[1] ?? null;
  const tabMatch = pathname.match(/^\/w\/[^/]+\/t\/([^/]+)/);
  const activeTabSlug = tabMatch?.[1] ? decodeURIComponent(tabMatch[1]) : null;
  const { workspaces } = useWorkspaces();
  // Favicon is driven by the cross-workspace rollup, not by the current
  // workspace's tab list, so a browser tab parked on Workspace A still
  // shows the bell when Workspace B has activity.
  useWindowAttention(workspaces);
  const activeWorkspace = wsSlug ? workspaces.find((w) => w.slug === wsSlug) : null;
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const settings = useSettings();
  const sidebarMode = !isMobile && settings.navLayout === 'sidebar';
  const [visitedWsSlugs, setVisitedWsSlugs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!wsSlug) return;
    setVisitedWsSlugs((prev) => {
      if (prev.has(wsSlug)) return prev;
      const next = new Set(prev);
      next.add(wsSlug);
      return next;
    });
  }, [wsSlug]);

  return (
    <div className="app-layout">
      <header className="ws-tabbar">
        {/* In sidebar mode the switcher no longer occupies the wordmark's
            slot, so the brand keeps its full wordmark. */}
        <Brand asLink={true} responsive={true} markOnly={!!activeWorkspace && !sidebarMode} />
        {activeWorkspace && isMobile && (
          // Single merged trigger on mobile: workspace + tab breadcrumb
          // opening the bottom-sheet NavTree. Replaces WorkspaceSwitcher
          // + TabBar for thumb-economy reasons.
          <MobileNavSwitcher activeWorkspaceSlug={activeWorkspace.slug} />
        )}
        {activeWorkspace && !isMobile && !sidebarMode && (
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
        {(!activeWorkspace || sidebarMode) && <span className="ws-tabbar-spacer" />}
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
      {wsSlug ? (
        <div className="app-body">
          {sidebarMode && (
            <aside className="sidenav">
              <NavTree
                variant="sidebar"
                activeWorkspaceSlug={wsSlug}
                activeTabSlug={activeTabSlug}
              />
            </aside>
          )}
          <div className="workspace-hosts">
            {[...visitedWsSlugs].map((slug) => (
              <div
                key={slug}
                className="workspace-host-slot"
                hidden={slug !== wsSlug}
                aria-hidden={slug !== wsSlug}
              >
                <WorkspaceShell wsSlug={slug} isActive={slug === wsSlug} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Outlet />
      )}
    </div>
  );
}
