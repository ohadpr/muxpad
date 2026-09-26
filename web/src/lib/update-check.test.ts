import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "New version — reload", and every case where it must stay quiet.
 *
 * The bug: an installed iOS PWA resumed from the app switcher restores the
 * document it already had. It never re-navigates, so it never re-reads
 * index.html, so a deploy reaches it only when the user force-quits — and there
 * is no reload gesture in a standalone PWA to force it by hand.
 *
 * Two things this must NOT do, both asserted below:
 *   - POLL. The signals are the ones the app already has (ws reconnect,
 *     document-visible) via subscribeResync. A timer here would repeat a bug
 *     this codebase has already paid for once.
 *   - AUTO-RELOAD. Agents are running and the user may be mid-message; the
 *     reload is a tap, and the tap flushes the chat's parked scroll position
 *     before the browsing context ends.
 */

const req = vi.fn();
vi.mock('../api', () => ({ req: (...args: unknown[]) => req(...args) }));

/** The resync subscribers registered by the module under test. */
let resync: Array<() => void> = [];
const unsubscribeResync = vi.fn();
vi.mock('../events', () => ({
  subscribeResync: (h: () => void) => {
    resync.push(h);
    return unsubscribeResync;
  },
}));

const flushChatScroll = vi.fn();
vi.mock('./chat-scroll', () => ({ flushChatScrollNow: () => flushChatScroll() }));

const MINE = 'index-aaaa1111.js';
const THEIRS = 'index-bbbb2222.js';

/** Put an entry script in the document, the way the built shell does. */
function loadedFrom(src: string): void {
  document.head.innerHTML = '';
  const s = document.createElement('script');
  s.setAttribute('type', 'module');
  s.setAttribute('src', src);
  document.head.appendChild(s);
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const load = () => import('./update-check');

beforeEach(() => {
  vi.resetModules();
  req.mockReset();
  flushChatScroll.mockReset();
  unsubscribeResync.mockReset();
  resync = [];
  loadedFrom(`/assets/${MINE}`);
});

describe('update check', () => {
  it('asks nothing at boot — the document it is running IS the answer', async () => {
    const mod = await load();
    mod.startUpdateCheck();
    await settle();
    expect(req).not.toHaveBeenCalled();
    expect(mod.pendingUpdate()).toBeNull();
    // …and exactly one subscription to the signals the app already fires.
    expect(resync).toHaveLength(1);
  });

  it('asks on the resync signal, with the HTTP cache bypassed', async () => {
    req.mockResolvedValue({ build: MINE });
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    expect(req).toHaveBeenCalledWith('/api/build', { cache: 'no-store' });
  });

  it('stays quiet when the server is serving the build we are running', async () => {
    req.mockResolvedValue({ build: MINE });
    const mod = await load();
    const seen = vi.fn();
    mod.subscribeUpdate(seen);
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });

  it('surfaces a new build after a deploy', async () => {
    req.mockResolvedValue({ build: THEIRS });
    const mod = await load();
    const seen = vi.fn();
    mod.subscribeUpdate(seen);
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBe(THEIRS);
    expect(seen).toHaveBeenCalledWith(THEIRS);
  });

  it('never subscribes when the document names no build (the dev server)', async () => {
    // vite dev's shell points at /src/main.tsx — a STABLE name, which would
    // compare unequal against the server's hashed dist/ shell and prompt on
    // every visibility flip for the whole session.
    loadedFrom('/src/main.tsx');
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    expect(resync).toHaveLength(0);
    expect(req).not.toHaveBeenCalled();
    expect(mod.pendingUpdate()).toBeNull();
  });

  it('collapses the pair of signals a resume fires into one request', async () => {
    // iOS delivers both at once: the document becomes visible and the socket it
    // silently killed reconnects a moment later. Both are subscribeResync.
    let release!: (v: { build: string }) => void;
    req.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    resync[0]?.();
    expect(req).toHaveBeenCalledTimes(1);
    release({ build: THEIRS });
    await settle();
    // …and the next genuine signal still asks.
    req.mockResolvedValue({ build: THEIRS });
    resync[0]?.();
    await settle();
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('says nothing when the request fails', async () => {
    req.mockRejectedValue(new Error('offline'));
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBeNull();
  });

  it('says nothing when the server cannot name its build', async () => {
    // A server with no built shell answers null. That is "no information", not
    // "you are up to date" and not "there is an update".
    req.mockResolvedValue({ build: null });
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBeNull();
  });

  it('holds a known update through a later answer it cannot read', async () => {
    req.mockResolvedValueOnce({ build: THEIRS }).mockResolvedValueOnce({ build: null });
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBe(THEIRS);
  });

  it('dismisses the prompt for that build, and speaks up for the next one', async () => {
    req.mockResolvedValue({ build: THEIRS });
    const mod = await load();
    const seen = vi.fn();
    mod.subscribeUpdate(seen);
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    mod.dismissUpdate();
    expect(mod.pendingUpdate()).toBeNull();
    expect(seen).toHaveBeenLastCalledWith(null);

    // Another deploy: dismissal was about a build, not about the feature.
    req.mockResolvedValue({ build: 'index-cccc3333.js' });
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBe('index-cccc3333.js');
  });

  it('retires the prompt if the server goes back to the build we are running', async () => {
    req.mockResolvedValueOnce({ build: THEIRS }).mockResolvedValueOnce({ build: MINE });
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBe(THEIRS);
    resync[0]?.();
    await settle();
    expect(mod.pendingUpdate()).toBeNull();
  });

  it('does not re-announce a build it has already reported', async () => {
    req.mockResolvedValue({ build: THEIRS });
    const mod = await load();
    const seen = vi.fn();
    mod.subscribeUpdate(seen);
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    resync[0]?.();
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second start does not double-subscribe', async () => {
    const mod = await load();
    mod.startUpdateCheck();
    mod.startUpdateCheck();
    expect(resync).toHaveLength(1);
  });
});

describe('applying the update', () => {
  it('flushes the parked scroll position BEFORE the reload', async () => {
    // The chat's remembered position is debounced in memory; the reader who
    // parked mid-history and taps reload must not be the one who loses it.
    // `pagehide` would flush too, but the order here is the guarantee.
    const order: string[] = [];
    flushChatScroll.mockImplementation(() => order.push('flush'));
    const mod = await load();
    mod.applyUpdate(() => order.push('reload'));
    expect(order).toEqual(['flush', 'reload']);
  });

  it('reloads even when nothing is pending — the tap is the decision', async () => {
    const reload = vi.fn();
    const mod = await load();
    mod.applyUpdate(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
