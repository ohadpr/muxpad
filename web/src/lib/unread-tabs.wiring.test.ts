import type { Tab } from '@muxpad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTabs } from './nav-search';

/**
 * THE INBOX RIDES THE SIDEBAR'S OWN LISTS. Every workspace list tabs.ts lands,
 * and every optimistic unread flip it makes, reaches lib/unread-tabs with no
 * request of its own — so reading a chat in one place drops it from Unread
 * everywhere on the same frame, and a poll that sees a new unread row places
 * it in stored order.
 */

const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({ id, slug: id, name: id, layout: 'p', created_at: 1, updated_at: 1, ...over }) as Tab;

let WS_TABS: Tab[] = [];
const INBOX: WorkspaceTabs[] = [
  { id: 'w1', slug: 'a', name: 'A', tabs: [tab('old', { unread: true, done: true })] },
];
const listTabs = vi.fn(async () => WS_TABS);
const listUnreadTabs = vi.fn(async () => ({ workspaces: INBOX }));
vi.mock('../api', () => ({
  api: {
    listTabs: () => listTabs(),
    listUnreadTabs: () => listUnreadTabs(),
    listAllTabs: async () => ({ workspaces: [] }),
  },
}));
vi.mock('../events', () => ({
  subscribe: () => () => {},
  subscribeReconnect: () => () => {},
  subscribeResync: () => () => {},
}));
vi.mock('../workspaces', () => ({
  refreshWorkspaces: async () => {},
  refreshWorkspacesSoon: () => {},
}));

const { refreshTabs, applyTabUnread } = await import('../tabs');
const { cachedUnreadTabs, loadUnreadTabs, resetUnreadTabsCache } = await import('./unread-tabs');
const ids = () => (cachedUnreadTabs() ?? []).map((g) => g.tabs.map((t) => t.id));

beforeEach(() => {
  resetUnreadTabsCache();
  listUnreadTabs.mockClear();
});

describe('tabs.ts feeds the inbox', () => {
  it('a landed workspace list replaces its group, in stored order, with no inbox request', async () => {
    await loadUnreadTabs();
    WS_TABS = [
      tab('n1', { unread: true }),
      tab('old', { done: true }),
      tab('n2', { unread: true }),
    ];
    await refreshTabs('w1');
    expect(ids()).toEqual([['n1', 'n2']]);
    expect(listUnreadTabs).toHaveBeenCalledTimes(1);
  });

  it('an optimistic mark-read drops the row on the same frame', async () => {
    await loadUnreadTabs();
    WS_TABS = [tab('old', { unread: true, done: true })];
    await refreshTabs('w1');
    expect(ids()).toEqual([['old']]);
    applyTabUnread('old', false);
    expect(ids()).toEqual([[]]);
  });
});
