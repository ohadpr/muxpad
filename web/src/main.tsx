import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { startEvents, subscribe, subscribeReconnect } from './events';
import { refreshWorkspaces } from './workspaces';
import { refreshTabs } from './tabs';
import { pushOpen } from './lib/external-open-store';
import './styles.css';

// Open the app-level event stream as soon as the bundle boots. On every
// reconnect, refetch the workspace list so we recover any events missed
// while the socket was down. Per-workspace tab caches refresh via the
// 5s poll in useTabs / useWorkspaces (also retriggered by tab/workspace
// events below). The active TabView has its own subscribe() that merges
// pane-level events into local state without waiting for any poll.
startEvents();
subscribeReconnect(() => void refreshWorkspaces());

// Global router: forward structural events into the right module caches.
// TabView subscribes directly to handle pane events for the active tab.
subscribe((e) => {
  switch (e.type) {
    case 'workspace.added':
    case 'workspace.updated':
    case 'workspace.removed':
      void refreshWorkspaces();
      return;
    case 'tab.added':
    case 'tab.removed':
      void refreshTabs(e.workspace_id);
      // Also refresh workspaces so workspace.tab_count stays current —
      // WorkspaceLayout's empty-state UI gates on it.
      void refreshWorkspaces();
      return;
    case 'tab.updated':
      // tab.updated doesn't carry workspace_id on the schema. Refresh
      // the workspace list as a coarse fallback; the 5s poll on the
      // active workspace's tab cache will pick up the name/slug change
      // shortly, and TabView's own subscriber handles updates for the
      // currently-viewed tab synchronously.
      void refreshWorkspaces();
      return;
    case 'pane.added':
    case 'pane.removed':
    case 'pane.updated':
      // TabView subscribes directly to merge these into local state.
      return;
    case 'external_url.open':
      // Surfaced as a click-to-open toast by ExternalOpenToasts so the
      // window.open() call lands inside a real user-gesture handler.
      // The label for the originating pane is computed in the component
      // (which has the live pane list), not here.
      pushOpen({
        url: e.url,
        ...(e.tab_id !== undefined ? { tab_id: e.tab_id } : {}),
        ...(e.pane_id !== undefined ? { pane_id: e.pane_id } : {}),
      });
      return;
  }
});

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<RouterProvider router={router} />);
