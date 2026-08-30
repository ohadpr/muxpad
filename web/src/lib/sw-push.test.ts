import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The service worker ships as a raw file (web/public/sw.js) — it is not part
 * of the bundle, so there is nothing to import. Load the source and run it
 * against a fake worker global instead; the handlers it registers are the
 * unit under test.
 *
 * What's being pinned: `pushsubscriptionchange` fires once, at a moment the
 * browser picks, and there is no retry. muxpad is only reachable over the
 * tailnet, so if that handler needs the network to get the VAPID key, a
 * rotation that happens off-tailnet kills push permanently and silently.
 */
// jsdom rewrites import.meta.url to an http URL, so resolve from the cwd
// instead (vitest runs from web/; the repo-root form is the fallback).
const SW_PATH = ['public/sw.js', 'web/public/sw.js']
  .map((p) => resolve(process.cwd(), p))
  .find(existsSync);
if (!SW_PATH) throw new Error('could not locate sw.js');
const SW_SRC = readFileSync(SW_PATH, 'utf-8');

const KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

interface Harness {
  handlers: Map<string, (e: unknown) => void>;
  subscribe: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  cacheEntry: { key: string } | null;
}

function loadWorker(opts: { cached: boolean; online: boolean }): Harness {
  const handlers = new Map<string, (e: unknown) => void>();
  const subscribe = vi.fn(async () => ({
    toJSON: () => ({ endpoint: 'https://push.example/abc' }),
  }));
  const fetchMock = vi.fn(async (url: string) => {
    if (!opts.online) throw new TypeError('Failed to fetch');
    if (url === '/api/push/vapid-public-key') {
      return { json: async () => ({ key: KEY }) };
    }
    return { ok: true };
  });
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    registration: { pushManager: { subscribe }, showNotification: vi.fn() },
  };
  const caches = {
    open: async () => ({
      match: async (url: string) =>
        opts.cached && url === '/api/push/vapid-public-key'
          ? { json: async () => ({ key: KEY }) }
          : undefined,
    }),
  };
  // biome-ignore lint/security/noGlobalEval: loading the real sw.js source is the point
  new Function('self', 'caches', 'fetch', SW_SRC)(self, caches, fetchMock);
  return { handlers, subscribe, fetch: fetchMock, cacheEntry: null };
}

/** Drive one event through the worker and await whatever it passed waitUntil. */
async function dispatch(h: Harness, type: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  h.handlers.get(type)?.({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

describe('sw pushsubscriptionchange', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a pushsubscriptionchange handler at all', () => {
    const h = loadWorker({ cached: true, online: true });
    expect(h.handlers.has('pushsubscriptionchange')).toBe(true);
  });

  it('re-subscribes with the CACHED key while completely offline', async () => {
    const h = loadWorker({ cached: true, online: false });
    await dispatch(h, 'pushsubscriptionchange');
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    const arg = h.subscribe.mock.calls[0]?.[0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(arg.userVisibleOnly).toBe(true);
    expect(arg.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(arg.applicationServerKey.length).toBe(65); // uncompressed P-256 point
  });

  it('prefers the cache over the network even when online', async () => {
    const h = loadWorker({ cached: true, online: true });
    await dispatch(h, 'pushsubscriptionchange');
    expect(h.fetch).not.toHaveBeenCalledWith('/api/push/vapid-public-key');
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });

  it('falls back to the network when nothing is cached', async () => {
    const h = loadWorker({ cached: false, online: true });
    await dispatch(h, 'pushsubscriptionchange');
    expect(h.fetch).toHaveBeenCalledWith('/api/push/vapid-public-key');
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });

  it('gives up quietly (no throw) when there is neither a cache nor a network', async () => {
    const h = loadWorker({ cached: false, online: false });
    await expect(dispatch(h, 'pushsubscriptionchange')).resolves.toBeUndefined();
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it('still re-subscribes when the server is unreachable for the re-register POST', async () => {
    // Cached key + dead server: the local subscription must be recreated
    // anyway. reconcilePush() re-registers it on the next load that connects.
    const h = loadWorker({ cached: true, online: false });
    await dispatch(h, 'pushsubscriptionchange');
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });
});

describe('sw is still push-only', () => {
  it('registers NO fetch handler — a caching SW would race hashed chunks', () => {
    const h = loadWorker({ cached: true, online: true });
    expect(h.handlers.has('fetch')).toBe(false);
    expect([...h.handlers.keys()].sort()).toEqual([
      'activate',
      'install',
      'notificationclick',
      'push',
      'pushsubscriptionchange',
    ]);
  });
});
