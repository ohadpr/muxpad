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

// The push service can rotate/expire a subscription. Best-effort
// resubscribe with the same server key and re-register with the backend.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('/api/push/vapid-public-key');
      const { key } = await res.json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(key),
      });
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
