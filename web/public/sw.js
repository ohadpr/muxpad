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
  const tag = data.tag || undefined;
  event.waitUntil(
    self.registration.showNotification(data.title || 'muxpad', {
      body: data.body || '',
      tag,
      // A tag makes the SECOND ring from the same pane silently REPLACE the
      // first. Without renotify the replacement lands mute and un-resurfaced,
      // so the tray still shows a stale entry the user already dismissed
      // mentally and the newest event never announces itself. renotify is only
      // legal alongside a tag (TypeError otherwise).
      ...(tag ? { renotify: true } : {}),
      timestamp: Date.now(),
      data: {
        url: data.url || '/',
        tab_id: data.tab_id || null,
        pane_id: data.pane_id || null,
      },
    }),
  );
});

// Cache Storage slots shared with the page (web/src/lib/push.ts and
// web/src/lib/push-target.ts). NOT a fetch-handling cache — nothing is
// intercepted and no app asset is stored; these are two key/value entries in
// the only storage a service worker and a window can both reach.
const PUSH_CACHE = 'muxpad-push-v1';
const VAPID_CACHE_URL = '/api/push/vapid-public-key';
const TARGET_CACHE_URL = '/__muxpad/push-target';

// How long to wait for the focused page to say "I routed myself" before
// falling back to forcing a load.
//
// The two costs are wildly asymmetric. Waiting too long: the user stares at
// the old view for the extra time. Not waiting long enough: we hard-load the
// deep link into a page that WOULD have routed itself, tearing down every
// terminal, websocket and scrollback in the window. The page we're waiting on
// has usually just been un-frozen by the focus() above — a backgrounded tab
// Chrome had frozen, or an iOS PWA the system just resumed — and unfreezing
// plus running one message handler routinely takes longer than the 700ms this
// used to allow. 1.5s is the point where the user starts to suspect the tap
// did nothing.
const ACK_TIMEOUT_MS = 1500;

/**
 * Which open window a notification tap should land on.
 *
 * `matchAll()` order is not "the window the user is looking at" — it is an
 * unspecified list that includes every same-origin window, so the old
 * `wins.find(...)` happily picked a chromeless pane POPOUT (`/p/<id>`) or a
 * stale background browser tab and steered THAT to the deep link, leaving the
 * window in front of the user untouched. Score instead: focused beats visible
 * beats anything, and a full-app window always beats a single-purpose one.
 * Sort is stable, so equal scores keep the platform's own ordering.
 */
function pickClient(clients) {
  const usable = clients.filter((c) => 'focus' in c && (c.frameType || 'top-level') !== 'nested');
  const score = (c) =>
    (c.focused ? 4 : 0) + (c.visibilityState === 'visible' ? 2 : 0) + (isSecondary(c.url) ? 0 : 1);
  return usable.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

/** Chromeless single-purpose windows: a pane popout and the doc surface. */
function isSecondary(url) {
  try {
    // Client urls are absolute, so the base is only there to keep `new URL`
    // from throwing on an unexpected relative one.
    const p = new URL(url || '/', 'http://muxpad.invalid').pathname;
    return p.startsWith('/p/') || p === '/doc' || p.startsWith('/doc/');
  } catch {
    return false;
  }
}

/**
 * Hand the target to the page and wait for an acknowledgement.
 *
 * The reply rides a MessageChannel port rather than a bare postMessage back,
 * so the ack can't be confused with any other SW↔page chatter. No ack (dropped
 * message, suspended page, engine that ignores it) resolves false and the
 * caller escalates.
 */
function postWithAck(win, message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => finish(true);
      win.postMessage(message, [ch.port2]);
    } catch {
      finish(false);
      return;
    }
    setTimeout(() => finish(false), ACK_TIMEOUT_MS);
  });
}

/**
 * Deposit the tap target where ANY instance of the page can find it later.
 *
 * This is the channel that survives the case every other one loses: an
 * installed iOS PWA has no `WindowClient.navigate()` at all, and
 * `clients.openWindow()` against an app that already has a window just brings
 * that window forward WITHOUT loading the URL. The tap then "worked" (the app
 * came up) on whatever tab it happened to be showing — the reported bug. The
 * page drains this entry at boot and on every visibility/focus change, so the
 * pane lands even when the platform tells us nothing.
 */
async function storePushTarget(target) {
  try {
    const cache = await caches.open(PUSH_CACHE);
    await cache.put(
      TARGET_CACHE_URL,
      new Response(JSON.stringify(target), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  } catch {
    // best effort — the postMessage/navigate paths still apply
  }
}

async function routeNotificationClick(target) {
  // Start the dead-drop, don't block on it. It is kept alive by the caller's
  // waitUntil either way, and every branch below that STARTS A PAGE awaits it
  // first — a page drains the dead-drop as it boots, so writing it afterwards
  // would both lose that tap and leave a stale entry to fire on the next
  // focus. The one branch that doesn't start a page (postMessage to a live
  // window) doesn't need to wait at all, which keeps the async gap in front of
  // focus() as short as possible: focus() and openWindow() are gated on the
  // notificationclick's transient activation, and every await spends some.
  const stored = storePushTarget(target);
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const win = pickClient(wins);
  if (win) {
    try {
      await win.focus();
    } catch {
      // focus can be refused; the routing below is what actually matters
    }
    // Let the running app route itself — instant and state-preserving. A
    // forced reload tears down every terminal, websocket and scrollback in the
    // window, so it is the fallback, not the first move.
    if (await postWithAck(win, { type: 'muxpad:push-navigate', ...target })) {
      await stored;
      return;
    }
  }
  // Everything from here LOADS a page, and that page reads the dead-drop at
  // boot. It has to be on disk first.
  await stored;
  // No ack (or no window at all). Force a real load of the deep link, which
  // boots the page on the cold path (?ptab=&pane= read before the router
  // mounts).
  if (win && typeof win.navigate === 'function') {
    try {
      await win.navigate(target.url);
      return;
    } catch {
      // uncontrolled client — fall through
    }
  }
  try {
    await self.clients.openWindow(target.url);
  } catch {
    // WebKit: no-op/reject when a window already exists. The cached target
    // above is what lands the pane once the app is foregrounded.
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const now = Date.now();
  event.waitUntil(
    routeNotificationClick({
      url: data.url || '/',
      tab_id: data.tab_id || null,
      pane_id: data.pane_id || null,
      // Identity of THIS tap. The page applies a given id at most once, so a
      // cached target can never yank a later manual navigation back, and two
      // channels delivering the same tap don't double-route.
      id: `${data.pane_id || data.url || 'muxpad'}:${now}`,
      ts: now,
    }),
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
// time (web/src/lib/push.ts) — see the constants above.
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
