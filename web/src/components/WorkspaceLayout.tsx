import { useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { refreshTabs, useTabs } from '../tabs';
import { refreshWorkspaces, useWorkspaces } from '../workspaces';
import { api } from '../api';
import { getLastTabSlug } from '../lib/last-visited';
import { TabView } from '../pages/TabView';

export interface WorkspaceShellProps {
  wsSlug: string;
  isActive: boolean;
}

/**
 * One workspace's tab host. Mounted by AppLayout for every visited
 * workspace (hidden when inactive) so xterm state survives workspace
 * switches as well as tab switches.
 */
export function WorkspaceShell({ wsSlug, isActive }: WorkspaceShellProps) {
  const navigate = useNavigate();
  const { workspaces } = useWorkspaces();
  const workspace = workspaces.find((w) => w.slug === wsSlug);
  const { tabs } = useTabs(workspace?.id ?? '');
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isExactWorkspacePath = pathname === `/w/${wsSlug}`;
  const urlTabSlug =
    isActive && pathname.startsWith(`/w/${wsSlug}/t/`)
      ? (pathname.match(/^\/w\/[^/]+\/t\/([^/]+)/)?.[1] ?? null)
      : null;
  const [lastTabSlug, setLastTabSlug] = useState<string | null>(null);
  const shownTabSlug = urlTabSlug ?? lastTabSlug;

  useEffect(() => {
    if (urlTabSlug) setLastTabSlug(urlTabSlug);
  }, [urlTabSlug]);

  const [visitedTabSlugs, setVisitedTabSlugs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!urlTabSlug) return;
    setVisitedTabSlugs((prev) => {
      if (prev.has(urlTabSlug)) return prev;
      const next = new Set(prev);
      next.add(urlTabSlug);
      return next;
    });
  }, [urlTabSlug]);

  // Recovery for a stale tab URL — a reload (or a PWA restoring its last
  // URL) can land on /w/:ws/t/:tab where the tab no longer exists (deleted
  // from another device). The tabs.map render below would then match
  // nothing and the user gets a permanent blank screen with no way out.
  // Once the tab list is confirmed fresh (length matches the workspace's
  // tab_count), bounce to the workspace root, where the redirect effect
  // below picks a valid tab (or the empty-state UI renders).
  useEffect(() => {
    if (!isActive || !workspace || !urlTabSlug) return;
    if (tabs.length !== workspace.tab_count) return; // list not fresh yet
    if (tabs.some((t) => t.slug === urlTabSlug)) return;
    void navigate({ to: '/w/$wsSlug', params: { wsSlug }, replace: true });
  }, [isActive, workspace, urlTabSlug, tabs, wsSlug, navigate]);

  useEffect(() => {
    if (!isActive || !workspace) return;
    if (!isExactWorkspacePath) return;
    if (tabs.length === 0) return;
    if (tabs.length !== workspace.tab_count) return;
    const storedSlug = getLastTabSlug(wsSlug);
    const target = (storedSlug && tabs.find((t) => t.slug === storedSlug)) || tabs[0]!;
    const search = Object.fromEntries(
      new URLSearchParams(window.location.search).entries(),
    );
    void navigate({
      to: '/w/$wsSlug/t/$tabSlug',
      params: { wsSlug, tabSlug: target.slug },
      search,
      replace: true,
    });
  }, [isActive, workspace, tabs, isExactWorkspacePath, wsSlug, navigate]);

  if (!workspace) {
    return isActive ? <div className="workspace-loading">loading…</div> : null;
  }

  if (
    isActive &&
    isExactWorkspacePath &&
    tabs.length === 0 &&
    workspace.tab_count === 0
  ) {
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

  if (!shownTabSlug) {
    return isActive ? <div className="workspace-loading">loading…</div> : null;
  }

  return (
    <div className="workspace-tabs-host">
      {tabs.map((t) => {
        if (!visitedTabSlugs.has(t.slug)) return null;
        const tabActive = isActive && t.slug === shownTabSlug;
        return (
          <div
            key={t.id}
            className="workspace-tab-slot"
            hidden={!tabActive}
            aria-hidden={!tabActive}
          >
            <TabView tabSlug={t.slug} isActive={tabActive} />
          </div>
        );
      })}
    </div>
  );
}

/** Route placeholder — shells are mounted by AppLayout. */
export function WorkspaceLayout() {
  return null;
}
