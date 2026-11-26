import type { MuxpadEvent, Tab, Workspace } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchableTab, WorkspaceTabs } from './nav-search';

/**
 * THE INBOX STORE — every unread chat, finished ones included, for the Unread
 * lists and badges. `/api/tabs/all` no longer carries finished history, so
 * these rows have to come from `/api/tabs/unread` and stay current from the
 * events and landed lists that already exist, with one shared request.
 */

let SERVER: WorkspaceTabs[] = [];
const listUnreadTabs = vi.fn(async () => ({ workspaces: SERVER }));
vi.mock('../api', () => ({ api: { listUnreadTabs: () => listUnreadTabs() } }));

const handlers = new Set<(e: MuxpadEvent) => void>();
const resyncs = new Set<() => void>();
vi.mock('../events', () => ({
  subscribe: (h: (e: MuxpadEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  subscribeReconnect: () => () => {},
  subscribeResync: (h: () => void) => {
    resyncs.add(h);
    return () => resyncs.delete(h);
  },
}));

// The hooks module reads these; the store under test must not pull in their
// polls and fetches.
vi.mock('../tabs', () => ({ useTabs: () => ({ tabs: [] }) }));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [] }),
  visibleWorkspaces: (w: unknown) => w,
}));

const {
  cachedUnreadTabs,
  loadUnreadTabs,
  mergeUnreadWorkspace,
  resetUnreadTabsCache,
  subscribeUnreadTabs,
} = await import('./unread-tabs');
const { withActiveRow, unreadCorpusFor, stickyUnreadRow } = await import('./use-unread');

const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({ id, slug: id, name: id, layout: 'p', created_at: 1, updated_at: 1, ...over }) as Tab;
const workspace = (id: string, slug: string, name: string, position: number): Workspace => ({
  id,
  slug,
  name,
  position,
  created_at: 1,
  updated_at: 1,
  tab_count: 1,
});
const emit = (e: MuxpadEvent) => {
  for (const h of handlers) h(e);
};
const ids = () => (cachedUnreadTabs() ?? []).map((g) => g.tabs.map((t) => t.id));

beforeEach(() => {
  resetUnreadTabsCache();
  listUnreadTabs.mockClear();
  SERVER = [
    // `old` is FINISHED (done) and unread — the row the live corpus lost.
    { id: 'w1', slug: 'a', name: 'A', tabs: [tab('old', { unread: true, done: true })] },
    { id: 'w2', slug: 'b', name: 'B', tabs: [tab('t3', { unread: true })] },
  ];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one shared read', () => {
  it('coalesces every mounting reader into one request and keeps finished unread rows', async () => {
    const [a, b, c] = await Promise.all([loadUnreadTabs(), loadUnreadTabs(), loadUnreadTabs()]);
    expect(listUnreadTabs).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(ids()).toEqual([['old'], ['t3']]);
    // …and a fresh answer is reused rather than re-asked.
    await loadUnreadTabs();
    expect(listUnreadTabs).toHaveBeenCalledTimes(1);
  });
});

describe('a landed workspace list is the group, for free', () => {
  it('drops a row read elsewhere and places a newly unread one in stored order', async () => {
    await loadUnreadTabs();
    const seen: WorkspaceTabs[][] = [];
    subscribeUnreadTabs((g) => seen.push(g));
    mergeUnreadWorkspace('w1', [
      tab('new', { unread: true, spawn_report: 'long prose' }),
      tab('old', { unread: false, done: true }),
      tab('x'),
    ]);
    expect(ids()).toEqual([['new'], ['t3']]);
    // Report text stripped, matching the route.
    expect(cachedUnreadTabs()?.[0]?.tabs[0]?.spawn_report).toBeUndefined();
    expect(seen).toHaveLength(1);
    // The same list again is not news.
    mergeUnreadWorkspace('w1', [tab('new', { unread: true }), tab('old')]);
    expect(seen).toHaveLength(1);
    expect(listUnreadTabs).toHaveBeenCalledTimes(1);
  });
});

describe('pushes', () => {
  it('drops a held row the moment a push says it was read, with no fetch', async () => {
    await loadUnreadTabs();
    subscribeUnreadTabs(() => {});
    emit({ type: 'tab.updated', tab: tab('old', { unread: false, done: true }) } as MuxpadEvent);
    expect(ids()).toEqual([[], ['t3']]);
    expect(listUnreadTabs).toHaveBeenCalledTimes(1);
  });

  it('turns a burst of newly-unread news into ONE refetch', async () => {
    await loadUnreadTabs();
    vi.useFakeTimers();
    subscribeUnreadTabs(() => {});
    SERVER = [
      {
        id: 'w1',
        slug: 'a',
        name: 'A',
        tabs: [tab('old', { unread: true }), tab('n1', { unread: true })],
      },
      {
        id: 'w2',
        slug: 'b',
        name: 'B',
        tabs: [tab('n2', { unread: true }), tab('t3', { unread: true })],
      },
    ];
    emit({ type: 'tab.updated', tab: tab('n1', { unread: true }) } as MuxpadEvent);
    emit({
      type: 'tab.added',
      workspace_id: 'w2',
      tab: tab('n2', { unread: true }),
    } as MuxpadEvent);
    emit({ type: 'pane.updated', tab_id: 'n3', pane: { id: 'p3', unread: true } } as MuxpadEvent);
    // The same bit again is not an edge.
    emit({ type: 'pane.updated', tab_id: 'n3', pane: { id: 'p3', unread: true } } as MuxpadEvent);
    await vi.advanceTimersByTimeAsync(2500);
    expect(listUnreadTabs).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([
      ['old', 'n1'],
      ['n2', 't3'],
    ]);
    // A bit already reported is not an edge, even after the refetch landed.
    emit({ type: 'pane.updated', tab_id: 'n3', pane: { id: 'p3', unread: true } } as MuxpadEvent);
    await vi.advanceTimersByTimeAsync(2500);
    expect(listUnreadTabs).toHaveBeenCalledTimes(2);
  });

  it('spends nothing on pane edges while no reader is mounted', async () => {
    await loadUnreadTabs();
    vi.useFakeTimers();
    emit({ type: 'pane.updated', tab_id: 'n9', pane: { id: 'p9', unread: true } } as MuxpadEvent);
    await vi.advanceTimersByTimeAsync(5000);
    expect(listUnreadTabs).toHaveBeenCalledTimes(1);
  });

  it('does not let an answer older than a push overwrite it', async () => {
    await loadUnreadTabs();
    subscribeUnreadTabs(() => {});
    let release: () => void = () => {};
    const stale = SERVER;
    listUnreadTabs.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ workspaces: stale });
        }),
    );
    for (const h of resyncs) h(); // a refetch goes out, carrying pre-push truth
    emit({ type: 'tab.updated', tab: tab('old', { unread: false }) } as MuxpadEvent);
    SERVER = [
      { id: 'w1', slug: 'a', name: 'A', tabs: [] },
      { id: 'w2', slug: 'b', name: 'B', tabs: [tab('t3', { unread: true })] },
    ];
    await vi.waitFor(() => expect(listUnreadTabs).toHaveBeenCalledTimes(2));
    release();
    await vi.waitFor(() => expect(listUnreadTabs).toHaveBeenCalledTimes(3));
    await loadUnreadTabs();
    expect(ids()).toEqual([[], ['t3']]);
  });
});

// A FAILED FIRST REQUEST IS NOT AN EMPTY INBOX. Open the UI while the server
// is restarting and the first /unread fails, leaving the cache null — which
// every path in the store used to treat as "nothing mounted to patch" and
// return on. The mounted rail then drew zero and "You're all caught up" for
// the rest of the session, no matter what arrived. Reproduced by review.
describe('recovering from a failed first request', () => {
  beforeEach(() => {
    listUnreadTabs.mockRejectedValueOnce(new Error('server restarting'));
  });

  it('asks again on reconnect, instead of holding a null cache forever', async () => {
    const seen: WorkspaceTabs[][] = [];
    subscribeUnreadTabs((g) => seen.push(g));
    expect(await loadUnreadTabs()).toEqual([]);
    expect(cachedUnreadTabs()).toBeNull();

    for (const h of resyncs) h();
    await vi.waitFor(() => expect(listUnreadTabs).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(ids()).toEqual([['old'], ['t3']]));
    expect(seen.length).toBeGreaterThan(0);
  });

  it('asks again when a push says something became unread', async () => {
    vi.useFakeTimers();
    subscribeUnreadTabs(() => {});
    await loadUnreadTabs();
    expect(cachedUnreadTabs()).toBeNull();

    emit({ type: 'tab.updated', tab: tab('t3', { unread: true }) } as MuxpadEvent);
    await vi.advanceTimersByTimeAsync(2500);
    expect(listUnreadTabs).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([['old'], ['t3']]);
  });

  it('asks again when a landed workspace list carries unread rows', async () => {
    vi.useFakeTimers();
    subscribeUnreadTabs(() => {});
    await loadUnreadTabs();
    mergeUnreadWorkspace('w2', [tab('t3', { unread: true })]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(listUnreadTabs).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([['old'], ['t3']]);
  });
});

describe('the chat you are on stays in the list', () => {
  const s = (id: string, ws: string, over: Partial<SearchableTab> = {}): SearchableTab => ({
    tabId: id,
    tabSlug: id,
    tabName: id,
    workspaceId: ws,
    workspaceSlug: ws,
    workspaceName: ws,
    paneIds: [],
    unread: true,
    ...over,
  });

  it('keeps a FINISHED chat, once read, where its stored order puts it', () => {
    const rows = [s('a1', 'w1'), s('a3', 'w1'), s('b1', 'w2')];
    const wsTabs = [tab('a1'), tab('a2', { done: true }), tab('a3')];
    const active = s('a2', 'w1', { unread: false, done: true });
    expect(withActiveRow(rows, active, wsTabs, ['w1', 'w2']).map((r) => r.tabId)).toEqual([
      'a1',
      'a2',
      'a3',
      'b1',
    ]);
  });

  it('places it where its workspace sorts when nothing else there is unread', () => {
    const rows = [s('a1', 'w1'), s('c1', 'w3')];
    const active = s('b1', 'w2', { unread: false });
    expect(
      withActiveRow(rows, active, [tab('b1')], ['w1', 'w2', 'w3']).map((r) => r.tabId),
    ).toEqual(['a1', 'b1', 'c1']);
  });

  it('flattens visible workspaces in workspace order with the store names', () => {
    const groups: WorkspaceTabs[] = [
      { id: 'w2', slug: 'old', name: 'Old', tabs: [tab('t3', { unread: true })] },
      { id: 'w1', slug: 'a', name: 'A', tabs: [tab('old', { unread: true })] },
    ];
    const ws: Workspace[] = [workspace('w1', 'a', 'A', 0), workspace('w2', 'b', 'Renamed', 1)];
    const flat = unreadCorpusFor(ws, groups);
    expect(flat.map((r) => [r.tabId, r.workspaceName])).toEqual([
      ['old', 'A'],
      ['t3', 'Renamed'],
    ]);
  });
});

/**
 * WHICH CHAT THE LIST HOLDS A PLACE FOR.
 *
 * `withActiveRow` exists for one reason: clicking an unread row reads it, the
 * inbox drops it, and a row vanishing from under the click punishes using the
 * list. It was wired as "always show the chat you are on", which is a much
 * bigger claim — so arriving at Unread from anywhere else showed a chat with
 * nothing unread in it: "when standing on a chat and clicking 'unread' it
 * always shows that same chat as well, weird."
 */
describe('the place the Unread list holds open', () => {
  it('holds the row you just clicked, once reading it drops it from the inbox', () => {
    // It was unread when you clicked it…
    let held = stickyUnreadRow(null, 't1', true);
    expect(held).toBe('t1');
    // …and reading it must not make it disappear under the pointer.
    held = stickyUnreadRow(held, 't1', false);
    expect(held).toBe('t1');
  });

  it('holds NOTHING for a chat that was already read when you arrived', () => {
    // The whole complaint: standing on a read chat, open Unread, and there it
    // is. It was never in the inbox, so the list has no place to hold for it.
    expect(stickyUnreadRow(null, 't9', false)).toBe(null);
  });

  it('forgets as soon as you move to another chat', () => {
    const held = stickyUnreadRow(stickyUnreadRow(null, 't1', true), 't1', false);
    expect(held).toBe('t1');
    // Moving on drops it — so this holds one id, not everything ever read.
    expect(stickyUnreadRow(held, 't2', false)).toBe(null);
    // …and coming back later does not resurrect it.
    expect(stickyUnreadRow(null, 't1', false)).toBe(null);
  });

  it('holds nothing when you are on no chat at all', () => {
    expect(stickyUnreadRow('t1', null, false)).toBe(null);
  });

  it('keeps holding a chat that is still unread — the ordinary case', () => {
    expect(stickyUnreadRow(null, 't1', true)).toBe('t1');
    expect(stickyUnreadRow('t1', 't1', true)).toBe('t1');
  });
});
