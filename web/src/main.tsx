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

// No JS height tracking — the CSS fallback `100svh` (small viewport
// height, stable across iOS URL-bar collapse/expand AND keyboard
// open/close) handles sizing. We used to mirror visualViewport.height
// here, but every URL-bar twitch during scroll triggered a resize
// cascade (--app-height → .app-layout → pane → fit → PTY resize) that
// garbled Ink-rendered TUI scrollback (Claude Code). A static
// stylesheet-only height keeps the pane CSS box constant, so XtermPane's
// own resize listener short-circuits at the dedup check.

// Stale lazy-chunk recovery. A dynamic import (e.g. the lazy EmojiMartPicker)
// fails with "Failed to fetch dynamically imported module" when a new build
// replaced the content-hashed chunk filenames while this page still holds the
// old index.html — common here, since muxpad's web bundle is rebuilt often.
// Vite fires `vite:preloadError` for these; reload once to pick up the fresh
// bundle. Guard with a short sessionStorage cooldown so a genuinely missing
// chunk (or an offline server) can't spin a reload loop.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault(); // we handle recovery; don't let it surface as unhandled
  const KEY = 'muxpad:preload-reloaded-at';
  const last = Number(sessionStorage.getItem(KEY) ?? 0);
  if (Date.now() - last < 10_000) return; // just reloaded — don't loop
  sessionStorage.setItem(KEY, String(Date.now()));
  window.location.reload();
});

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<RouterProvider router={router} />);
