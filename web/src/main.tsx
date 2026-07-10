import { RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { startEvents, subscribe, subscribeReconnect } from './events';
import { pushOpen } from './lib/external-open-store';
import { setLastPaneId } from './lib/last-visited';
import { registerServiceWorker } from './lib/push';
import { router } from './router';
import { refreshTabs } from './tabs';
import { refreshWorkspaces } from './workspaces';
import './styles.css';

/**
 * Self-embed breaker. A pane's web face pointed at muxpad's own origin
 * recursively embeds the app — each nesting level boots another full client
 * (event sockets, polls, more nested iframes) until the browser exhausts
 * resources and the whole page goes unresponsive (observed live: hundreds of
 * ERR_INSUFFICIENT_RESOURCES failures). ShellPaneBody refuses to create such
 * iframes; this is the defense-in-depth backstop for any other path. A
 * cross-origin parent throws on the .origin read — that's a legitimate embed
 * and boots normally.
 */
function isSelfEmbedded(): boolean {
  if (window.self === window.top) return false;
  try {
    return window.top?.location.origin === window.location.origin;
  } catch {
    return false;
  }
}
const selfEmbedded = isSelfEmbedded();

// Open the app-level event stream as soon as the bundle boots. On every
// reconnect, refetch the workspace list so we recover any events missed
// while the socket was down. Per-workspace tab caches refresh via the
// 5s poll in useTabs / useWorkspaces (also retriggered by tab/workspace
// events below). The active TabView has its own subscribe() that merges
// pane-level events into local state without waiting for any poll.
if (!selfEmbedded) {
  startEvents();
  subscribeReconnect(() => void refreshWorkspaces());
  // Keep the push service worker registered/updated. No-op over plain
  // http (no secure context → no navigator.serviceWorker) and harmless
  // where push was never enabled — the SW has no fetch handler.
  registerServiceWorker();

  // Notification-tap deep links, cold-start path: a tap that BOOTS the PWA
  // lands on the payload URL, whose ?ptab=&pane= params say which pane to
  // focus. Record it as the tab's last-visited pane BEFORE the router
  // mounts (TabView falls back to that store when it has no active pane),
  // then strip the params so they don't linger in the address bar.
  {
    const params = new URLSearchParams(window.location.search);
    const ptab = params.get('ptab');
    const pane = params.get('pane');
    if (ptab && pane) {
      setLastPaneId(ptab, pane);
      params.delete('ptab');
      params.delete('pane');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }

  // Notification-tap deep links, warm path: the service worker focused this
  // already-running window and hands us the target instead of hard-reloading
  // (WindowClient.navigate() reloads the app and iOS rejects it for
  // uncontrolled clients). Route through the SPA router and point the tab
  // at the right pane — TabView listens for muxpad:show-pane when mounted;
  // the last-visited store covers it when it mounts after navigation.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data as {
      type?: string;
      url?: string;
      tab_id?: string | null;
      pane_id?: string | null;
    } | null;
    if (d?.type !== 'muxpad:push-navigate' || !d.url) return;
    if (d.tab_id && d.pane_id) setLastPaneId(d.tab_id, d.pane_id);
    // Push the clean path — the ?ptab=&pane= params are only for cold boots.
    router.history.push(d.url.split('?')[0] ?? d.url);
    if (d.pane_id) {
      const paneId = d.pane_id;
      // Give the route transition a beat so the target TabView is mounted.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('muxpad:show-pane', { detail: { paneId } }));
      }, 150);
    }
  });
}

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
if (selfEmbedded) {
  root.render(
    <div style={{ padding: 16, fontFamily: 'system-ui', opacity: 0.7 }}>
      muxpad can’t embed itself — open this URL in its own tab.
    </div>,
  );
} else {
  root.render(<RouterProvider router={router} />);
}
