import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

const { cachedAllTabs, loadAllTabs, resetAllTabsCache, subscribeAllTabs } = await import(
  './all-tabs'
);

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
