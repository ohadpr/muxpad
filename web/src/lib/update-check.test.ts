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
    expect(req).toHaveBeenCalledWith('/api/build', expect.objectContaining({ cache: 'no-store' }));
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

  // ── THE WEDGE ───────────────────────────────────────────────────────────
  // "mobile stopped updating again". A request that NEVER SETTLES — what a
  // fetch caught in flight by an iOS suspension can look like on resume: no
  // answer, no error — left `asking` true for the life of the page, and every
  // later resume returned at the guard. Measured headless on the real server:
  // one frozen /api/build, then three resumes, zero further requests, no
  // banner, while the server was serving a new build. An installed PWA is
  // RESUMED for days, so the page's life is the whole bug; a relaunch clears it.
  it('is not wedged by a request that never answers — the next resume still asks', async () => {
    vi.useFakeTimers();
    try {
      req.mockImplementationOnce(() => new Promise(() => {})); // frozen forever
      const mod = await load();
      const seen: Array<string | null> = [];
      mod.subscribeUpdate((b) => seen.push(b));
      mod.startUpdateCheck();
      resync[0]?.();
      expect(req).toHaveBeenCalledTimes(1);
      // Time passes with the request still hanging (the app was suspended)…
      await vi.advanceTimersByTimeAsync(60_000);
      // …and the app comes back to a server serving a new build.
      req.mockResolvedValue({ build: THEIRS });
      resync[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(req).toHaveBeenCalledTimes(2);
      expect(seen.at(-1)).toBe(THEIRS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not wedged even when the resume beats the timeout — a stale ask is abandoned', async () => {
    // iOS freezes timers with the page, so on resume the timeout that should
    // have fired during the suspension may run AFTER the visibility event. The
    // guard reads the clock, not only the timer.
    vi.useFakeTimers();
    try {
      req.mockImplementationOnce(() => new Promise(() => {}));
      const mod = await load();
      mod.startUpdateCheck();
      resync[0]?.();
      // The clock moves (suspended for a minute) but no timer has run yet.
      vi.setSystemTime(Date.now() + 60_000);
      req.mockResolvedValue({ build: THEIRS });
      resync[0]?.();
      expect(req).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the request it sends — an abortable ask, never an open-ended one', async () => {
    req.mockResolvedValue({ build: MINE });
    const mod = await load();
    mod.startUpdateCheck();
    resync[0]?.();
    await settle();
    const init = req.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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
