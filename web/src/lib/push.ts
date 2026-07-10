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
  const { key } = await fetchJson<{ key: string }>('/api/push/vapid-public-key');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyBytes(key) as BufferSource,
    }));
  await fetchJson('/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(sub.toJSON()),
  });
  return 'enabled';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetchJson('/api/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined); // best effort — the server prunes dead subs anyway
    await sub.unsubscribe();
  }
  return 'disabled';
}

/** Fire a round-trip test notification to every subscribed device. */
export async function sendTestPush(): Promise<void> {
  await fetchJson('/api/push/test', { method: 'POST' });
}

async function fetchJson<T = unknown>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
