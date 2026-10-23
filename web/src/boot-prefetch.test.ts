import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PREFETCH IS AN OPTIMISATION, AND AN OPTIMISATION THAT CAN SHOW STALE
 * DATA IS A BUG.
 *
 * index.html fires `GET /api/boot` before the bundle has parsed, and the two
 * stores adopt the answer instead of opening their own round trips. Everything
 * below is about the cases where they must NOT: a workspace that is not the
 * one asked for, a second reader coming back for more, a payload that has aged
 * past usefulness, and every flavour of failure.
 */

const listWorkspaces = vi.fn(async () => [{ id: 'w1', slug: 'personal' }] as never[]);
const listTabs = vi.fn(async () => [{ id: 'fetched' }] as never[]);
vi.mock('./api', () => ({
  api: { listWorkspaces: () => listWorkspaces(), listTabs: () => listTabs() },
  req: vi.fn(),
}));
vi.mock('./events', () => ({ subscribe: () => () => {}, subscribeReconnect: () => () => {} }));
vi.mock('./lib/all-tabs', () => ({
  mergeWorkspaceTabs: () => {},
  refreshCorpusForTab: () => {},
}));

const payload = (over: Record<string, unknown> = {}) => ({
  workspaces: [{ id: 'w1', slug: 'personal', name: 'Personal' }],
  workspaceId: 'w1',
  tabs: [{ id: 'prefetched', workspace_id: 'w1' }],
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the boot prefetch', () => {
  beforeEach(() => {
    vi.resetModules();
    listWorkspaces.mockClear();
    listTabs.mockClear();
    window.__muxpadBoot = undefined;
  });

  it('serves the workspace list without a second request', async () => {
    window.__muxpadBoot = Promise.resolve(payload() as never);
    const mod = await import('./workspaces');
    mod.refreshWorkspacesOnMount();
    await settle();
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('serves the tab list without a second request', async () => {
    window.__muxpadBoot = Promise.resolve(payload() as never);
    const tabs = await import('./tabs');
    await tabs.refreshTabs('w1');
    expect(listTabs).not.toHaveBeenCalled();
    expect(tabs.cachedTabsFor('w1')?.map((t) => t.id)).toEqual(['prefetched']);
  });

  it('is used ONCE — a second reader gets a real request', async () => {
    window.__muxpadBoot = Promise.resolve(payload() as never);
    const tabs = await import('./tabs');
    await tabs.refreshTabs('w1');
    await tabs.refreshTabs('w1');
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('NEVER serves one workspace’s tabs for another', async () => {
    window.__muxpadBoot = Promise.resolve(payload() as never);
    const tabs = await import('./tabs');
    await tabs.refreshTabs('w2');
    expect(listTabs).toHaveBeenCalledTimes(1);
    expect(tabs.cachedTabsFor('w2')?.map((t) => t.id)).toEqual(['fetched']);
  });

  it('falls back when the prefetch failed', async () => {
    window.__muxpadBoot = Promise.resolve(null);
    const tabs = await import('./tabs');
    await tabs.refreshTabs('w1');
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('falls back when the prefetch REJECTED — an old server, a dropped link', async () => {
    window.__muxpadBoot = Promise.reject(new Error('404'));
    const mod = await import('./workspaces');
    mod.refreshWorkspacesOnMount();
    await settle();
    await settle();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('falls back when there is no prefetch at all', async () => {
    const tabs = await import('./tabs');
    await tabs.refreshTabs('w1');
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('ignores a payload that is not the shape it claims', async () => {
    window.__muxpadBoot = Promise.resolve({ nonsense: true } as never);
    const tabs = await import('./tabs');
    await tabs.refreshTabs('w1');
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('expires: a late reader asks the server rather than adopting old bytes', async () => {
    window.__muxpadBoot = Promise.resolve(payload() as never);
    const boot = await import('./boot-prefetch');
    // Far past the window, whenever the module happened to be imported.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + boot.STALE_AFTER_MS * 10);
    try {
      expect(boot.bootPending('tabs')).toBe(false);
      expect(await boot.bootTabs('w1')).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
