import { RouterProvider } from '@tanstack/react-router';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { startEvents, subscribe, subscribeReconnect } from './events';
import { pushOpen } from './lib/external-open-store';
import { setLastPaneId } from './lib/last-visited';
import { startPresence } from './lib/presence';
import { reconcilePush, registerServiceWorker } from './lib/push';
import { setPushFocusPane } from './lib/push-focus';
import {
  type PushTargetDeps,
  type PushTargetSink,
  clearStoredPushTarget,
  createPushTargetSink,
  parsePushTarget,
  takeStoredPushTarget,
} from './lib/push-target';
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

/**
 * Opened once the router is mounted; every notification tap routes through it.
 * Null when the app never booted (self-embedded frame) — nothing to route.
 */
let pushSink: PushTargetSink | null = null;

// Open the app-level event stream as soon as the bundle boots. On every
// reconnect, refetch the workspace list so we recover any events missed
// while the socket was down. The per-workspace tab caches take their own
// baseline refetch on reconnect (see tabs.ts) — the 5s poll is only a
// backstop, and it is STOPPED while the document is hidden, which is
// exactly when a disconnect is most likely. The active TabView has its
// own subscribe() that merges
// pane-level events into local state without waiting for any poll.
if (!selfEmbedded) {
  startEvents();
  subscribeReconnect(() => void refreshWorkspaces());
  // Keep the push service worker registered/updated. No-op over plain
  // http (no secure context → no navigator.serviceWorker) and harmless
  // where push was never enabled — the SW has no fetch handler.
  registerServiceWorker();
  // Self-heal a subscription that silently died (browser rotated it while we
  // were off-tailnet, server pruned it, data dir rebuilt). No-op unless the
  // user actually enabled push on this device. See lib/push.ts.
  void reconcilePush();

  // How a notification tap actually reaches the right pane. Three channels,
  // because which one is available depends entirely on the platform:
  //
  //   COLD   the tap boots the PWA onto the payload URL — ?ptab=&pane= below.
  //   WARM   the SW postMessages the target; we route through the SPA router
  //          with no reload (every terminal + socket in the window survives).
  //   OPAQUE the platform foregrounds the app and says nothing (installed iOS
  //          PWA: no WindowClient.navigate, and openWindow on a live app just
  //          focuses it). The SW leaves the target in Cache Storage; we drain
  //          it at boot and on every visibility/focus change.
  //
  // All three converge on ONE sink, which dedupes by tap id and holds a tap
  // that arrives before the router is mounted (the boot drain below does
  // exactly that) instead of routing into a router that isn't listening.
  const pushTargetDeps: PushTargetDeps = {
    navigateToTab: ({ wsSlug, tabSlug, paneId }) => {
      // Through the ROUTER, not a raw history push of the clean path — the
      // latter can leave us on the current tab.
      void router.navigate({
        to: '/w/$wsSlug/t/$tabSlug',
        params: { wsSlug, tabSlug },
        ...(paneId ? { search: { pane: paneId } } : {}),
      });
    },
    navigateToPath: (path) => router.history.push(path),
    rememberPane: setLastPaneId,
    forceFocusPane: setPushFocusPane,
    showPane: (paneId) =>
      window.dispatchEvent(new CustomEvent('muxpad:show-pane', { detail: { paneId } })),
    schedule: (fn, ms) => void setTimeout(fn, ms),
  };
  const sink = createPushTargetSink(pushTargetDeps);
  pushSink = sink;

  // COLD path. Record the pane as the tab's last-visited one AND in the
  // once-only push-focus store BEFORE the router mounts (TabView reads both),
  // then strip the params so they don't linger in the address bar.
  {
    const params = new URLSearchParams(window.location.search);
    const ptab = params.get('ptab');
    const pane = params.get('pane');
    if (ptab && pane) {
      setLastPaneId(ptab, pane);
      // Stripping ?pane below removes TabView's URL seed, so the deterministic
      // store is what carries the target the rest of the way.
      setPushFocusPane(ptab, pane);
      params.delete('ptab');
      params.delete('pane');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }

  // WARM path.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data as { type?: string } | null;
      if (d?.type !== 'muxpad:push-navigate') return;
      const target = parsePushTarget(d);
      if (!target) return;
      let delivery: ReturnType<typeof sink.deliver>;
      try {
        delivery = sink.deliver(target);
      } catch (err) {
        // Routing itself blew up. Do NOT ack: an unanswered message is what
        // makes the service worker escalate to a real navigation, and a hard
        // load of the deep link is exactly the right recovery for an app whose
        // router just threw.
        console.error('push-navigate failed', err);
        return;
      }
      // The SW ALWAYS writes the dead-drop too; once the tap has actually been
      // ROUTED, retire it rather than leave it to fire again on the next focus.
      // A merely HELD tap keeps its dead-drop: if this document is discarded
      // before the router mounts (the message landed mid-navigation, or the
      // bundle is still loading and the user reloads), the entry is the only
      // remaining copy and the next document drains it.
      if (delivery !== 'held') void clearStoredPushTarget();
      // Acknowledge, so the SW knows it does NOT need to force a reload. Sent
      // even when the sink deduped or queued — the tap IS handled either way,
      // and a missing ack costs the user a full app reload.
      e.ports[0]?.postMessage({ ok: true });
    });
    // REQUIRED with addEventListener: the client's service-worker message
    // queue starts DISABLED and is only released by setting `onmessage` or
    // calling startMessages(). Without this the handler above is registered
    // and never fires — which is precisely why the warm path "silently did
    // nothing" and every tap had to fall back to a full reload (or, on iOS,
    // where there is no navigate() at all, to nothing).
    navigator.serviceWorker.startMessages?.();

    // OPAQUE path: drain the SW's dead-drop now and whenever we come forward.
    // Gated on serviceWorker existing at all — no SW, no depositor, and this
    // runs on every window focus.
    let draining = false;
    const drain = () => {
      if (draining) return; // focus + visibilitychange fire together
      draining = true;
      void takeStoredPushTarget()
        .then((t) => {
          if (t) sink.deliver(t);
        })
        .catch((err) => console.error('push-target drain failed', err))
        .finally(() => {
          draining = false;
        });
    };
    drain();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') drain();
    });
    window.addEventListener('focus', drain);
  }
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

/**
 * Releases held notification taps once the router is really mounted.
 *
 * `root.render()` only SCHEDULES the first commit (React 18 flushes it in a
 * microtask), and `router.navigate()` before that commit goes nowhere — the
 * provider hasn't subscribed yet. The boot drain of the service worker's
 * dead-drop resolves inside exactly that window, so the tap that foregrounded
 * the app was the one most likely to be dropped. A sibling effect is the
 * cheapest deterministic "the tree is committed" signal: effects of an earlier
 * sibling (RouterProvider) run first.
 */
function PushSinkGate() {
  useEffect(() => {
    pushSink?.ready();
  }, []);
  return null;
}

const root = createRoot(document.getElementById('root') as HTMLElement);
if (selfEmbedded) {
  root.render(
    <div style={{ padding: 16, fontFamily: 'system-ui', opacity: 0.7 }}>
      muxpad can’t embed itself — open this URL in its own tab.
    </div>,
  );
} else {
  // Report active-device presence so the server holds push notifications while
  // we're here (resumes once every device goes quiet).
  startPresence();
  root.render(
    <>
      <RouterProvider router={router} />
      <PushSinkGate />
    </>,
  );
}
