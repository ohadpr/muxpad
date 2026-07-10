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
  const { key } = await req<{ key: string }>('/api/push/vapid-public-key');
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
  return 'enabled';
}

export async function disablePush(): Promise<PushState> {
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
