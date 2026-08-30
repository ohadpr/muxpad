import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * The tap path. This is where "push notifications work, but clicking them
 * almost never takes me to the pane that needs me" lived: the handler picked an
 * arbitrary window and then relied on `WindowClient.navigate()` (absent in
 * WebKit) with `clients.openWindow()` as the fallback (a no-op focus for an
 * installed PWA that already has a window). Every assertion below pins one of
 * those.
 */

interface FakeClient {
  id: string;
  url: string;
  focused?: boolean;
  visibilityState?: string;
  frameType?: string;
  focus: () => Promise<void>;
  postMessage: (msg: unknown, transfer?: unknown[]) => void;
  navigate?: (url: string) => Promise<unknown>;
}

interface ClickHarness {
  handlers: Map<string, (e: unknown) => void>;
  openWindow: ReturnType<typeof vi.fn>;
  cachePut: ReturnType<typeof vi.fn>;
  /** Every side effect, in the order it happened. */
  order: string[];
}

function loadClickWorker(
  clients: FakeClient[],
  opts: { putGate?: Promise<void> } = {},
): ClickHarness {
  const handlers = new Map<string, (e: unknown) => void>();
  const order: string[] = [];
  const openWindow = vi.fn(async () => {
    order.push('openWindow');
    return null;
  });
  const cachePut = vi.fn(async () => {
    if (opts.putGate) await opts.putGate;
    order.push('cachePut');
    return undefined;
  });
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => clients),
      openWindow,
    },
    registration: { pushManager: { subscribe: vi.fn() }, showNotification: vi.fn() },
  };
  const caches = {
    open: async () => ({ match: async () => undefined, put: cachePut, delete: async () => true }),
  };
  // biome-ignore lint/security/noGlobalEval: loading the real sw.js source is the point
  new Function('self', 'caches', 'fetch', SW_SRC)(self, caches, vi.fn());
  return { handlers, openWindow, cachePut, order };
}

/** Fire a notification tap and settle everything it kicked off. */
async function click(
  h: ClickHarness,
  data: Record<string, unknown> = { url: '/w/dev/t/tab?ptab=T1&pane=P1', pane_id: 'P1' },
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const close = vi.fn();
  h.handlers.get('notificationclick')?.({
    notification: { close, data },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  // The no-ack path waits on a real 700ms timer; run it out rather than sleep.
  const settled = Promise.all(pending);
  await vi.advanceTimersByTimeAsync(2000);
  await settled;
}

function makeClient(over: Partial<FakeClient> & { id: string; url: string }): FakeClient {
  return {
    focus: vi.fn(async () => undefined),
    postMessage: vi.fn(),
    ...over,
  };
}

/** A client that answers the SW's ack port, i.e. a live muxpad page. */
function ackingClient(over: Partial<FakeClient> & { id: string; url: string }): FakeClient {
  const c = makeClient(over);
  c.postMessage = vi.fn((_msg: unknown, transfer?: unknown[]) => {
    const port = (transfer?.[0] ?? null) as MessagePort | null;
    port?.postMessage({ ok: true });
  });
  return c;
}

describe('sw notificationclick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('opens a window when nothing is running (cold start)', async () => {
    const h = loadClickWorker([]);
    await click(h);
    expect(h.openWindow).toHaveBeenCalledWith('/w/dev/t/tab?ptab=T1&pane=P1');
  });

  it('ALWAYS deposits the target in Cache Storage', async () => {
    // The only channel that survives an installed iOS PWA, where the platform
    // foregrounds the app and reports nothing back.
    const h = loadClickWorker([]);
    await click(h);
    expect(h.cachePut).toHaveBeenCalledTimes(1);
    const body = await (h.cachePut.mock.calls[0]?.[1] as Response).json();
    expect(body).toMatchObject({ url: '/w/dev/t/tab?ptab=T1&pane=P1', pane_id: 'P1' });
    expect(typeof body.id).toBe('string');
    expect(body.ts).toBeGreaterThan(0);
  });

  it('finishes the deposit BEFORE starting a page that will read it', async () => {
    // A booting page drains the dead-drop as it loads. Opening the window
    // first races the write: either the new page misses the tap, or it misses
    // it AND the entry lands behind it, to fire on some later focus.
    const h = loadClickWorker([]);
    await click(h);
    expect(h.order).toEqual(['cachePut', 'openWindow']);
  });

  it('does NOT make a live page wait on the deposit before handing it the tap', async () => {
    // focus() and openWindow() are gated on the notificationclick's transient
    // activation, and every await in front of them spends some of it. A slow
    // Cache Storage write must not sit between the tap and the window the user
    // is looking at; the write only has to finish before we start a PAGE.
    let release = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const win = ackingClient({ id: 'a', url: 'https://mux/w/dev/t/other', focused: true });
    const h = loadClickWorker([win], { putGate: blocked });
    const done = click(h);
    await vi.advanceTimersByTimeAsync(50);
    expect(win.focus).toHaveBeenCalled();
    expect(win.postMessage).toHaveBeenCalled();
    // …and the write still lands, because waitUntil holds the worker open.
    release();
    await done;
    expect(h.cachePut).toHaveBeenCalledTimes(1);
  });

  it('finishes the deposit before FORCING a navigation too', async () => {
    // Same race as the cold start: navigate() loads a document that drains the
    // dead-drop on boot.
    const navOrder: string[] = [];
    const win = makeClient({ id: 'a', url: 'https://mux/w/dev/t/other', focused: true });
    win.navigate = vi.fn(async () => {
      navOrder.push('navigate');
      return null;
    });
    const h = loadClickWorker([win]);
    await click(h);
    expect(h.order).toEqual(['cachePut']);
    expect(navOrder).toEqual(['navigate']);
    const nav = (win.navigate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
    const put = h.cachePut.mock.invocationCallOrder[0] ?? 0;
    expect(put).toBeLessThan(nav);
  });

  it('hands a live page the target and does NOT reload it', async () => {
    const win = ackingClient({ id: 'a', url: 'https://mux/w/dev/t/other', focused: true });
    win.navigate = vi.fn(async () => null);
    const h = loadClickWorker([win]);
    await click(h);
    expect(win.focus).toHaveBeenCalled();
    expect(win.postMessage).toHaveBeenCalled();
    const msg = (win.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(msg).toMatchObject({ type: 'muxpad:push-navigate', pane_id: 'P1' });
    // A reload would tear down every terminal and socket in the window.
    expect(win.navigate).not.toHaveBeenCalled();
    expect(h.openWindow).not.toHaveBeenCalled();
  });

  it('forces a real navigation when the page never acks', async () => {
    const win = makeClient({ id: 'a', url: 'https://mux/w/dev/t/other', focused: true });
    win.navigate = vi.fn(async () => null);
    const h = loadClickWorker([win]);
    await click(h);
    expect(win.navigate).toHaveBeenCalledWith('/w/dev/t/tab?ptab=T1&pane=P1');
  });

  it('falls back to openWindow where WindowClient.navigate does not exist (WebKit)', async () => {
    const win = makeClient({ id: 'a', url: 'https://mux/w/dev/t/other', focused: true });
    const h = loadClickWorker([win]);
    await click(h);
    expect(h.openWindow).toHaveBeenCalledWith('/w/dev/t/tab?ptab=T1&pane=P1');
    // …and the cached target is what actually lands the pane there.
    expect(h.cachePut).toHaveBeenCalledTimes(1);
  });

  it('escalates to openWindow when navigate rejects (uncontrolled client)', async () => {
    const win = makeClient({ id: 'a', url: 'https://mux/w/dev/t/other' });
    win.navigate = vi.fn(async () => {
      throw new TypeError('uncontrolled');
    });
    const h = loadClickWorker([win]);
    await click(h);
    expect(h.openWindow).toHaveBeenCalled();
  });

  it('routes the FOCUSED window, not whichever one matchAll listed first', async () => {
    const background = ackingClient({ id: 'bg', url: 'https://mux/w/dev/t/one' });
    const foreground = ackingClient({
      id: 'fg',
      url: 'https://mux/w/dev/t/two',
      focused: true,
      visibilityState: 'visible',
    });
    const h = loadClickWorker([background, foreground]);
    await click(h);
    expect(foreground.postMessage).toHaveBeenCalled();
    expect(background.postMessage).not.toHaveBeenCalled();
  });

  it('never hijacks a chromeless pane popout when a real app window exists', async () => {
    // A popout is a legitimate same-origin window; steering it to a workspace
    // deep link renders the whole app inside it and leaves the window the user
    // is actually looking at untouched.
    const popout = ackingClient({ id: 'pop', url: 'https://mux/p/P9' });
    const app = ackingClient({ id: 'app', url: 'https://mux/w/dev/t/one' });
    const h = loadClickWorker([popout, app]);
    await click(h);
    expect(app.postMessage).toHaveBeenCalled();
    expect(popout.postMessage).not.toHaveBeenCalled();
  });

  it('ignores nested (iframe) clients — a pane web face is not the app window', async () => {
    const iframe = ackingClient({ id: 'if', url: 'https://mux/w/dev/t/one', frameType: 'nested' });
    const h = loadClickWorker([iframe]);
    await click(h);
    expect(iframe.postMessage).not.toHaveBeenCalled();
    expect(h.openWindow).toHaveBeenCalled();
  });

  it('carries the LATEST tap when notifications collapse on one pane', async () => {
    const win = ackingClient({ id: 'a', url: 'https://mux/w/dev/t/one', focused: true });
    const h = loadClickWorker([win]);
    await click(h, { url: '/w/dev/t/one?ptab=T1&pane=P1', tab_id: 'T1', pane_id: 'P1' });
    await click(h, { url: '/w/dev/t/two?ptab=T2&pane=P2', tab_id: 'T2', pane_id: 'P2' });
    const post = win.postMessage as ReturnType<typeof vi.fn>;
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ pane_id: 'P2', tab_id: 'T2' });
    // Distinct tap ids, so the page applies both rather than deduping the second.
    const first = post.mock.calls[0]?.[0] as { id: string };
    const second = post.mock.calls[1]?.[0] as { id: string };
    expect(first.id).not.toBe(second.id);
  });

  it('degrades to the root for a payload with no url', async () => {
    const h = loadClickWorker([]);
    await click(h, {});
    expect(h.openWindow).toHaveBeenCalledWith('/');
  });
});

describe('sw push', () => {
  it('re-alerts on a collapsed repeat instead of landing mute', () => {
    const handlers = new Map<string, (e: unknown) => void>();
    const showNotification = vi.fn();
    const self = {
      addEventListener: (t: string, fn: (e: unknown) => void) => handlers.set(t, fn),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn() },
      registration: { pushManager: { subscribe: vi.fn() }, showNotification },
    };
    // biome-ignore lint/security/noGlobalEval: loading the real sw.js source is the point
    new Function('self', 'caches', 'fetch', SW_SRC)(self, { open: async () => ({}) }, vi.fn());
    handlers.get('push')?.({
      data: { json: () => ({ title: 'claude · muxpad', body: 'asks: ok?', tag: 'P1', url: '/x' }) },
      waitUntil: () => undefined,
    });
    expect(showNotification).toHaveBeenCalledWith(
      'claude · muxpad',
      expect.objectContaining({ tag: 'P1', renotify: true, body: 'asks: ok?' }),
    );
    // renotify without a tag is a TypeError — never set one on an untagged push.
    handlers.get('push')?.({
      data: { json: () => ({ title: 'muxpad', body: 'hi' }) },
      waitUntil: () => undefined,
    });
    expect(showNotification.mock.calls[1]?.[1]).not.toHaveProperty('renotify');
  });
});
