import { RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { startEvents, subscribe, subscribeReconnect } from './events';
import { pushOpen } from './lib/external-open-store';
import { router } from './router';
import { refreshTabs } from './tabs';
import { refreshWorkspaces } from './workspaces';
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

// iOS Safari's bottom URL bar is an overlay in some states: the bar
// floats on top of the layout area without being subtracted from the
// CSS viewport units (vh/dvh/svh all report the wrong height). The
// only signal that reliably matches the *truly visible* area is
// visualViewport.height, which we mirror to a CSS variable that the
// stylesheet uses as the body height. Falls back to 100svh on browsers
// without visualViewport (none in practice for this app, but cheap).
//
// We also poll the height on visualViewport's resize event — fires on
// URL-bar collapse/expand, software-keyboard show/hide, orientation
// change — and on plain window resize for desktop.
if (typeof window !== 'undefined' && window.visualViewport) {
  const sync = () => {
    document.documentElement.style.setProperty(
      '--app-height',
      `${window.visualViewport!.height}px`,
    );
  };
  window.visualViewport.addEventListener('resize', sync);
  window.visualViewport.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  sync();
}

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<RouterProvider router={router} />);
