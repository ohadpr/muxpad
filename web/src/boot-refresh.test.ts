import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Boot request amplification.
 *
 * The workspace/tab stores already coalesced CONCURRENT mount refreshes, but a
 * cold load isn't concurrent — it's a staircase. AppLayout fetches workspaces;
 * only when they land does WorkspaceShell mount and fetch tabs; only when THOSE
 * land does TabView mount and ask for both again. Nothing is ever in flight at
 * the moment the next mount checks, so the coalescer never fired: a cold load
 * issued five `GET /api/workspaces?all=1` and three `GET /api/tabs`, each of
 * which walks workspaces → tabs → panes synchronously through better-sqlite3.
 *
 * These tests drive the mount entry points the way that staircase does —
 * refresh, await, refresh again — rather than rendering components.
 */

const listWorkspaces = vi.fn(async () => [] as never[]);
const listTabs = vi.fn(async () => [] as never[]);
vi.mock('./api', () => ({
  api: {
    listWorkspaces: () => listWorkspaces(),
    listTabs: () => listTabs(),
  },
  req: vi.fn(),
}));

const WS = 'ws_01';
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('workspaces mount refresh', () => {
  beforeEach(() => {
    vi.resetModules();
    listWorkspaces.mockClear();
  });

  it('issues ONE request for a staircase of sequential mounts', async () => {
    const mod = await import('./workspaces');
    mod.refreshWorkspacesOnMount(); // AppLayout
    await settle();
    mod.refreshWorkspacesOnMount(); // WorkspaceShell, after the first landed
    await settle();
    mod.refreshWorkspacesOnMount(); // TabView, after tabs landed
    await settle();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('still coalesces genuinely concurrent mounts', async () => {
    const mod = await import('./workspaces');
    mod.refreshWorkspacesOnMount();
    mod.refreshWorkspacesOnMount();
    mod.refreshWorkspacesOnMount();
    await settle();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('refetches once the list is no longer current', async () => {
    vi.useFakeTimers();
    try {
      const mod = await import('./workspaces');
      mod.refreshWorkspacesOnMount();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(2500); // past the freshness window
      mod.refreshWorkspacesOnMount();
      await vi.advanceTimersByTimeAsync(0);
      expect(listWorkspaces).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still lets a post-mutation caller read back its own write', async () => {
    // refreshWorkspaces() is the exported, UNcoalesced path on purpose: a
    // component that just renamed a workspace must not be handed a reply that
    // predates its write.
    const mod = await import('./workspaces');
    await mod.refreshWorkspaces();
    await mod.refreshWorkspaces();
    await mod.refreshWorkspaces();
    expect(listWorkspaces).toHaveBeenCalledTimes(3);
  });

  it('does not let a DISCARDED reply mark the cache fresh', async () => {
    // A reply superseded by a later refresh never reaches the cache, so it
    // must not start the 2s freshness window either — otherwise a mount in
    // that window is fobbed off with data older than the reply that was
    // thrown away, and issues no request to correct it.
    // The timing is the whole test: the discarded reply has to land LATER
    // than the winner, then we probe the gap between the two would-be
    // freshness windows — past the winner's, still inside the loser's.
    vi.useFakeTimers();
    try {
      const mod = await import('./workspaces');
      let release!: () => void;
      listWorkspaces.mockImplementationOnce(
        () =>
          new Promise<never[]>((r) => {
            release = () => r([]);
          }),
      );
      const stale = mod.refreshWorkspaces(); // t=0, starts first, hangs
      await mod.refreshWorkspaces(); // t=0, lands first, WINS (settledAt=0)
      expect(listWorkspaces).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1500);
      release(); // t=1500: the superseded reply finally lands, discarded
      await stale;

      // t=2100: past the winner's window (2000), inside the loser's (3500).
      vi.advanceTimersByTime(600);
      mod.refreshWorkspacesOnMount();
      await vi.advanceTimersByTimeAsync(0);
      expect(listWorkspaces).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('tabs mount refresh', () => {
  beforeEach(() => {
    vi.resetModules();
    listTabs.mockClear();
  });

  it('issues ONE request for a staircase of sequential mounts', async () => {
    const mod = await import('./tabs');
    mod.refreshTabsOnMount(WS); // WorkspaceShell
    await settle();
    mod.refreshTabsOnMount(WS); // TabView
    await settle();
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('keeps per-workspace slots independent', async () => {
    const mod = await import('./tabs');
    mod.refreshTabsOnMount(WS);
    mod.refreshTabsOnMount('ws_02');
    await settle();
    expect(listTabs).toHaveBeenCalledTimes(2);
  });

  it('freshTabs() reuses a list that just landed instead of refetching', async () => {
    const mod = await import('./tabs');
    await mod.refreshTabs(WS);
    expect(listTabs).toHaveBeenCalledTimes(1);
    await mod.freshTabs(WS);
    await mod.freshTabs(WS);
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('freshTabs() does fetch when it has nothing current', async () => {
    const mod = await import('./tabs');
    expect(await mod.freshTabs(WS)).toEqual([]);
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('freshTabs() joins an in-flight mount refresh rather than racing it', async () => {
    const mod = await import('./tabs');
    let release!: () => void;
    listTabs.mockImplementationOnce(
      () =>
        new Promise<never[]>((r) => {
          release = () => r([]);
        }),
    );
    mod.refreshTabsOnMount(WS);
    const joined = mod.freshTabs(WS);
    release();
    await joined;
    expect(listTabs).toHaveBeenCalledTimes(1);
  });
});

describe('event stream reconnect handlers', () => {
  beforeEach(() => vi.resetModules());

  it('does not treat the FIRST connect as a reconnect', async () => {
    // Every reconnect handler refetches a baseline. On the first connect there
    // is no gap to recover from — the mount fetches are already in flight —
    // so firing them just duplicated the boot requests.
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        FakeWS.last = this;
      }
    }
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    try {
      const { startEvents, subscribeReconnect } = await import('./events');
      const handler = vi.fn();
      subscribeReconnect(handler);
      startEvents();
      FakeWS.last?.onopen?.();
      expect(handler).not.toHaveBeenCalled();
      // A genuine reconnect (socket dropped, a new one opened) still fires.
      FakeWS.last?.onopen?.();
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
