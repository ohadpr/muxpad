import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTabs } from './nav-search';

/**
 * THE CORPUS IS LIVE — the half of the `@` feature that never refreshed.
 *
 * The cross-workspace corpus was built for a search box: focus it, type, choose,
 * gone in seconds, so one fetch per session was right and there is deliberately
 * no poll. The `@` picker then put the SAME corpus behind two things that stay on
 * screen for hours — the chip inside a sent message, and the card for work
 * directed elsewhere — and neither had any way to hear that the chat it draws had
 * been renamed, archived, retired or revived. A `ChatPane` took one snapshot on
 * first use and held it for as long as it was mounted: the sidebar row updated
 * and the chip in the conversation beside it did not.
 *
 * These drive the real store with real events and NO fetch — `listAllTabs` is
 * counted to prove the push is what did the work, because a test that let a
 * refetch happen would pass with the subscription deleted.
 */

const listAllTabs = vi.fn(async () => ({ workspaces: SERVER }));
vi.mock('../api', () => ({ api: { listAllTabs: () => listAllTabs() } }));

/** Every live subscriber, so a test can push an event into the store. */
const handlers = new Set<(e: MuxpadEvent) => void>();
vi.mock('../events', () => ({
  subscribe: (h: (e: MuxpadEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  // Never fired here — these tests are about the PUSH path. The corpus's own
  // reconnect refetch is held by sidebar-freshness.test.ts, which drives it
  // alongside the sidebar cache because the property is that the two agree.
  subscribeResync: () => () => {},
}));

const { cachedAllTabs, loadAllTabs, refreshCorpusForTab, resetAllTabsCache, subscribeAllTabs } =
  await import('./all-tabs');

const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({ id, slug: id, name: id, layout: 'p', created_at: 1, updated_at: 1, ...over }) as Tab;

let SERVER: WorkspaceTabs[] = [];

const emit = (e: MuxpadEvent) => {
  for (const h of handlers) h(e);
};

beforeEach(() => {
  resetAllTabsCache();
  listAllTabs.mockClear();
  SERVER = [
    { id: 'w1', slug: 'personal', name: 'Personal', tabs: [tab('t1'), tab('t2')] },
    { id: 'w2', slug: 'work', name: 'Work', tabs: [tab('t3')] },
  ];
});

/** The corpus row for a tab id, wherever it lives. */
const row = (id: string) => (cachedAllTabs() ?? []).flatMap((g) => g.tabs).find((t) => t.id === id);

describe('a server push reaches every holder of the corpus', () => {
  it('patches a renamed / retired row in place, with no fetch', () => {
    // The lifecycle case from the report: direct work to a chat, it retires on
    // delivery, and the card in the conversation went on drawing it live.
    return loadAllTabs().then(() => {
      const seen: WorkspaceTabs[][] = [];
      subscribeAllTabs((g) => seen.push(g));
      listAllTabs.mockClear();

      emit({
        type: 'tab.updated',
        tab: tab('t2', { name: 'renamed', done: true, done_reason: 'delivered' }),
      } as MuxpadEvent);

      expect(seen).toHaveLength(1);
      expect(row('t2')).toMatchObject({ name: 'renamed', done: true });
      // The whole point of patching rather than refetching.
      expect(listAllTabs).not.toHaveBeenCalled();
    });
  });

  it('says nothing about a row it is not holding', () => {
    // The corpus is LAZY by design. A `tab.updated` for a workspace nobody has
    // asked about must not become a request, and must not wake subscribers for a
    // change none of them can see.
    return loadAllTabs().then(() => {
      const seen: WorkspaceTabs[][] = [];
      subscribeAllTabs((g) => seen.push(g));
      emit({ type: 'tab.updated', tab: tab('stranger') } as MuxpadEvent);
      expect(seen).toEqual([]);
      expect(listAllTabs).toHaveBeenCalledTimes(1);
    });
  });

  it('does not build a corpus out of an event before one has been asked for', () => {
    // Nothing is fetched on mount, and an event must not change that — the whole
    // reason this module is lazy is the mobile first paint.
    const seen: WorkspaceTabs[][] = [];
    subscribeAllTabs((g) => seen.push(g));
    emit({ type: 'tab.updated', tab: tab('t1', { name: 'nope' }) } as MuxpadEvent);
    expect(cachedAllTabs()).toBeNull();
    expect(seen).toEqual([]);
  });

  it('takes a new chat into the corpus, so a fresh sub-chat can be mentioned', () => {
    return loadAllTabs().then(() => {
      const seen: WorkspaceTabs[][] = [];
      subscribeAllTabs((g) => seen.push(g));
      emit({ type: 'tab.added', workspace_id: 'w2', tab: tab('t4') } as MuxpadEvent);
      expect(seen).toHaveLength(1);
      expect(row('t4')).toBeDefined();
      // …in the workspace it belongs to, not wherever.
      expect(
        cachedAllTabs()
          ?.find((g) => g.id === 'w2')
          ?.tabs.map((t) => t.id),
      ).toEqual(['t3', 't4']);
    });
  });

  it('ignores an add for a workspace it does not hold, rather than inventing one', () => {
    // A group needs a name and a slug to be rankable; an event carries neither.
    return loadAllTabs().then(() => {
      const seen: WorkspaceTabs[][] = [];
      subscribeAllTabs((g) => seen.push(g));
      emit({ type: 'tab.added', workspace_id: 'w9', tab: tab('t9') } as MuxpadEvent);
      expect(seen).toEqual([]);
      expect(row('t9')).toBeUndefined();
    });
  });

  it('never lets one tab be added twice', () => {
    return loadAllTabs().then(() => {
      emit({ type: 'tab.added', workspace_id: 'w1', tab: tab('t1') } as MuxpadEvent);
      expect(
        (cachedAllTabs() ?? []).flatMap((g) => g.tabs).filter((t) => t.id === 't1'),
      ).toHaveLength(1);
    });
  });

  it('drops a deleted chat, so it stops being offerable in the picker', () => {
    return loadAllTabs().then(() => {
      const seen: WorkspaceTabs[][] = [];
      subscribeAllTabs((g) => seen.push(g));
      emit({ type: 'tab.removed', workspace_id: 'w1', tab_id: 't1' } as MuxpadEvent);
      expect(seen).toHaveLength(1);
      expect(row('t1')).toBeUndefined();
      expect(row('t2')).toBeDefined();
    });
  });

  it('stops talking to a reader that has unsubscribed', () => {
    return loadAllTabs().then(() => {
      const seen: WorkspaceTabs[][] = [];
      const off = subscribeAllTabs((g) => seen.push(g));
      off();
      emit({ type: 'tab.updated', tab: tab('t1', { name: 'x' }) } as MuxpadEvent);
      expect(seen).toEqual([]);
      // The cache itself still moved — only the listener left.
      expect(row('t1')).toMatchObject({ name: 'x' });
    });
  });

  it('tells its readers when a FETCH lands too, not only a push', () => {
    // Subscribing is how a mounted pane stops holding a stale copy; the first
    // corpus is one of the things it must hear about.
    const seen: WorkspaceTabs[][] = [];
    subscribeAllTabs((g) => seen.push(g));
    return loadAllTabs().then(() => {
      expect(seen).toHaveLength(1);
      expect(seen[0]?.flatMap((g) => g.tabs).map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    });
  });
});

/**
 * AN OLDER ANSWER MUST NOT OVERWRITE A NEWER PUSH.
 *
 * A `/tabs/all` request issued before a push can land after it, carrying the
 * pre-push row. Publishing it — and calling the corpus fresh — put the old name
 * (or a retired chat back to `working`) on every chip and card, with nothing
 * left to heal it: no poll, and a status-edge fetch that fired meanwhile had
 * simply JOINED the stale request.
 */
describe('a response that predates a push', () => {
  /** Hand-resolved `listAllTabs` answers, so a test controls landing order. */
  const pending: Array<(v: { workspaces: WorkspaceTabs[] }) => void> = [];
  const hold = () =>
    listAllTabs.mockImplementationOnce(
      () => new Promise<{ workspaces: WorkspaceTabs[] }>((r) => pending.push(r)),
    );
  const snapshot = () => structuredClone(SERVER);
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    pending.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    listAllTabs.mockImplementation(async () => ({ workspaces: SERVER }));
  });

  it('is not published over the push, and a fresh fetch follows', async () => {
    await loadAllTabs();
    vi.advanceTimersByTime(10_000); // past FRESH_MS
    listAllTabs.mockClear();

    hold();
    const old = snapshot();
    void loadAllTabs();
    // The rename happens on the server and is pushed while the request travels.
    SERVER = SERVER.map((g) => ({
      ...g,
      tabs: g.tabs.map((t) => (t.id === 't2' ? { ...t, name: 'renamed' } : t)),
    }));
    emit({ type: 'tab.updated', tab: tab('t2', { name: 'renamed' }) } as MuxpadEvent);
    expect(row('t2')?.name).toBe('renamed');

    pending.shift()?.({ workspaces: old });
    await settle();
    await settle();
    expect(row('t2')?.name).toBe('renamed');
    // …and it went back for an answer that is at least as new as the push.
    expect(listAllTabs).toHaveBeenCalledTimes(2);
  });

  it('applies on the FIRST fetch too, when the push had no corpus to patch', async () => {
    hold();
    const old = snapshot();
    void loadAllTabs();
    SERVER = SERVER.map((g) => ({
      ...g,
      tabs: g.tabs.map((t) => (t.id === 't2' ? { ...t, done: true } : t)),
    }));
    emit({ type: 'tab.updated', tab: tab('t2', { done: true }) } as MuxpadEvent);

    pending.shift()?.({ workspaces: old });
    await settle();
    await settle();
    expect(row('t2')?.done).toBe(true);
    expect(listAllTabs).toHaveBeenCalledTimes(2);
  });

  it('a status edge during the request does not just join it', async () => {
    await loadAllTabs();
    subscribeAllTabs(() => {});
    vi.advanceTimersByTime(10_000);
    listAllTabs.mockClear();

    hold();
    const old = snapshot();
    void loadAllTabs();
    SERVER = SERVER.map((g) => ({
      ...g,
      tabs: g.tabs.map((t) => (t.id === 't3' ? { ...t, status: 'idle' } : t)),
    }));
    // No tab.updated on a status edge — only this nudge.
    vi.useRealTimers();
    refreshCorpusForTab('t3');
    await new Promise((r) => setTimeout(r, 300));

    pending.shift()?.({ workspaces: old });
    await settle();
    await settle();
    expect(row('t3')?.status).toBe('idle');
  });
});
