/**
 * Client side of Web Push: service-worker registration + subscription
 * lifecycle. iOS specifics that shaped this:
 *   - Push requires a secure context (https) — over plain http
 *     `navigator.serviceWorker` doesn't exist and state is 'unsupported'.
 *   - On iOS, push is only offered to the INSTALLED PWA (added to home
 *     screen), not to a Safari tab.
 *   - `Notification.requestPermission()` must run inside a user gesture
 *     (the settings-menu button click), or iOS auto-denies.
 */

import { req } from '../api';

export type PushState = 'unsupported' | 'denied' | 'enabled' | 'disabled';

/**
 * Cache Storage entry holding the server's VAPID public key.
 *
 * This is NOT a step toward a caching service worker — there is still no
 * fetch handler and nothing about the app bundle is cached. It exists for one
 * reason: `pushsubscriptionchange` fires inside the service worker at a moment
 * we don't choose, and the old handler answered it by fetching the key from
 * the server. muxpad is tailnet-only, so a browser that rotates the
 * subscription while the phone is off-tailnet (café wifi, cellular with
 * Tailscale off) got a network error, threw, and lost push PERMANENTLY — the
 * event does not repeat. Reading the key from here makes re-subscription work
 * with no network at all.
 *
 * Both window and worker contexts see the same Cache Storage, so the window
 * writes it at subscribe time and the worker reads it.
 */
const PUSH_CACHE = 'muxpad-push-v1';
const VAPID_CACHE_URL = '/api/push/vapid-public-key';

/**
 * Does the user WANT push on this device? Distinct from "is there a live
 * subscription": a subscription the browser dropped (or the server pruned)
 * looks identical to one the user switched off, and only one of those should
 * be silently recreated at boot. Set on enable, cleared on disable.
 */
const INTENT_KEY = 'muxpad.push.enabled';

function wantsPush(): boolean {
  try {
    return localStorage.getItem(INTENT_KEY) === '1';
  } catch {
    return false;
  }
}

function setWantsPush(on: boolean): void {
  try {
    if (on) localStorage.setItem(INTENT_KEY, '1');
    else localStorage.removeItem(INTENT_KEY);
  } catch {
    // private mode / storage disabled — reconciliation just won't self-heal
  }
}

async function cacheVapidKey(key: string): Promise<void> {
  if (!('caches' in globalThis)) return;
  try {
    const cache = await caches.open(PUSH_CACHE);
    await cache.put(
      VAPID_CACHE_URL,
      new Response(JSON.stringify({ key }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  } catch {
    // best effort — the SW still has its network fallback
  }
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Register the SW at boot. Idempotent; also how an updated sw.js gets
 * picked up. No-op where unsupported (http, old browsers).
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.error('sw registration failed', err);
  });
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'enabled' : 'disabled';
}

// base64url (VAPID key wire format) → Uint8Array; Safari rejects the
// bare-string form of applicationServerKey.
function vapidKeyBytes(base64url: string): Uint8Array {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Must be called from a user-gesture handler (button click). */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'disabled';

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  await subscribeAndRegister(reg);
  setWantsPush(true);
  return 'enabled';
}

/**
 * Shared by the user-gesture path and the boot reconciliation: fetch the
 * current server key, make the local subscription match it, and (re-)register
 * it with the server. Idempotent — the server upserts on endpoint.
 */
async function subscribeAndRegister(reg: ServiceWorkerRegistration): Promise<void> {
  const { key } = await req<{ key: string }>('/api/push/vapid-public-key');
  // Stash it BEFORE subscribing: from here on, a `pushsubscriptionchange` can
  // re-subscribe without reaching the server.
  await cacheVapidKey(key);
  const wanted = vapidKeyBytes(key);
  let sub = await reg.pushManager.getSubscription();
  // A subscription minted under DIFFERENT VAPID keys (rotation, vapid.json
  // loss) fails 401/403 on every server send, forever — the server prunes
  // it, but the client must also stop REUSING it or push stays broken
  // while the UI claims 'enabled'. Re-subscribe under the current key.
  if (sub && !keyMatches(sub.options.applicationServerKey, wanted)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: wanted as BufferSource,
  });
  await req('/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(sub.toJSON()),
  });
}

/**
 * Boot-time self-heal, called once per load. Push has several ways to end up
 * silently broken with the UI none the wiser:
 *
 *   - `pushsubscriptionchange` fired while the device was off-tailnet, so the
 *     worker could neither re-subscribe (pre-cache fix) nor tell the server;
 *   - the server pruned the subscription (410 from a transient outage, or a
 *     vapid.json loss) but the browser still holds it;
 *   - the data dir was restored/rebuilt and the subscription table is gone.
 *
 * All of them are invisible until the user notices they stopped getting
 * notifications. Re-running the subscribe+register handshake on every load
 * that reaches the server closes all three, and costs one tiny POST.
 *
 * Only runs when the user asked for push on this device (see INTENT_KEY) and
 * permission is still granted — it must never resurrect push someone turned
 * off, and it must never prompt (no user gesture here).
 */
export async function reconcilePush(): Promise<void> {
  if (!supported()) return;
  if (Notification.permission !== 'granted') return;
  if (!wantsPush()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await subscribeAndRegister(reg);
  } catch {
    // Offline / server down / permission revoked mid-flight. Nothing to do:
    // the next load that reaches the server tries again.
  }
}

export async function disablePush(): Promise<PushState> {
  setWantsPush(false);
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await req('/api/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined); // best effort — the server prunes dead subs anyway
    await sub.unsubscribe();
  }
  return 'disabled';
}

/** Fire a round-trip test notification to every subscribed device. */
export async function sendTestPush(): Promise<void> {
  await req('/api/push/test', { method: 'POST' });
}

/** Bytewise compare of the subscription's key against the server's current
 *  one. A null stored key (some browsers don't expose it) reads as a match
 *  — can't verify, so don't churn the subscription. */
function keyMatches(stored: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!stored) return true;
  const a = new Uint8Array(stored);
  if (a.length !== wanted.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== wanted[i]) return false;
  return true;
}
