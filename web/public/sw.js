// muxpad service worker — Web Push only. Deliberately NO fetch handler /
// offline caching: the app's HTML-shell + hashed-assets caching strategy
// (see server/src/index.ts) must stay the single source of truth, and a
// caching SW is exactly the stale-bundle trap it avoids.

// Take over immediately on update: without skipWaiting a revised SW sits
// 'waiting' until every client closes, and without claim() the page that
// registered us stays uncontrolled until its next navigation — which broke
// notification-tap navigation (WindowClient.navigate rejects uncontrolled
// clients). We keep no caches, so an eager takeover is always safe.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // non-JSON payload — show something rather than nothing
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'muxpad', {
      body: data.body || '',
      tag: data.tag || undefined,
      data: {
        url: data.url || '/',
        tab_id: data.tab_id || null,
        pane_id: data.pane_id || null,
      },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  event.waitUntil(
    (async () => {
      // Reuse an open window (the installed PWA) when there is one.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => 'focus' in w);
      if (win) {
        await win.focus();
        // FORCE a load of the deep-link URL so the page boots on the cold path
        // (?ptab=&pane= read at startup, before the router mounts) — the only
        // reliable pane focus on iOS standalone PWAs, where the in-page
        // postMessage route the running instance was meant to handle silently
        // does nothing (message dropped, or a different active pane already set).
        // navigate() is preferred (no new window) but rejects for an
        // uncontrolled client; openWindow() then forces the same URL load.
        if ('navigate' in win) {
          try {
            await win.navigate(url);
            return;
          } catch {
            // fall through to openWindow
          }
        }
        await self.clients.openWindow(url);
        return;
      }
      // Cold start: the URL itself carries the pane focus (?ptab=&pane=),
      // read at boot.
      await self.clients.openWindow(url);
    })(),
  );
});

// base64url (VAPID key wire format) → Uint8Array, the one applicationServerKey
// type every engine accepts.
function vapidKeyBytes(base64url) {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// The VAPID public key, stashed in Cache Storage by the page at subscribe
// time (web/src/lib/push.ts). NOT a fetch-handling cache — nothing is
// intercepted and no app asset is stored here; this is a key/value slot that
// happens to live in the only storage a service worker can read synchronously
// enough during `pushsubscriptionchange`.
const PUSH_CACHE = 'muxpad-push-v1';
const VAPID_CACHE_URL = '/api/push/vapid-public-key';

async function cachedVapidKey() {
  try {
    const cache = await caches.open(PUSH_CACHE);
    const hit = await cache.match(VAPID_CACHE_URL);
    if (!hit) return null;
    const { key } = await hit.json();
    return typeof key === 'string' && key ? key : null;
  } catch {
    return null;
  }
}

// The push service can rotate/expire a subscription. Best-effort
// resubscribe with the same server key and re-register with the backend.
//
// Cache FIRST, network second. muxpad is reachable only over the tailnet, and
// the browser picks the moment this event fires — typically while the device
// is somewhere else entirely. The old handler fetched the key unconditionally,
// so an off-tailnet rotation threw before ever calling subscribe() and push
// died permanently: the event is one-shot, and the app had no path that would
// ever notice. Re-subscribing offline still leaves the SERVER not knowing the
// new endpoint, but that half self-heals — reconcilePush() re-registers on the
// next load that reaches the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let key = await cachedVapidKey();
      if (!key) {
        try {
          key = (await (await fetch(VAPID_CACHE_URL)).json()).key;
        } catch {
          // Off-network and nothing cached (push was enabled by a build that
          // predates the cache). reconcilePush() on the next load re-subscribes.
          return;
        }
      }
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(key),
      });
      // Best-effort: unreachable server just means the next load registers it.
      try {
        await fetch('/api/push/subscriptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch {
        // deliberately silent
      }
    })(),
  );
});
