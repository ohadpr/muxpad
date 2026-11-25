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

const {
  cachedAllTabs,
  loadAllTabs,
  mergeWorkspaceTabs,
  refreshCorpusForTab,
  resetAllTabsCache,
  subscribeAllTabs,
} = await import('./all-tabs');

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

  it('replays the push over the response without another full fetch', async () => {
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
    // The pushed row already is the newer answer.
    expect(listAllTabs).toHaveBeenCalledTimes(1);
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
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });

  it('replays a sidebar list during first load and preserves fetched report text', async () => {
    hold();
    const old = snapshot();
    old[0]!.tabs[0] = tab('t1', { spawn_report: 'held report', spawn_report_state: 'ok' });
    const loading = loadAllTabs();
    mergeWorkspaceTabs('w1', [tab('t1', { name: 'fresh sidebar', spawn_report_state: 'ok' })]);
    pending.shift()?.({ workspaces: old });
    await loading;
    await settle();
    expect(row('t1')).toMatchObject({ name: 'fresh sidebar', spawn_report: 'held report' });
    expect(row('t2')).toBeUndefined();
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });

  it('replays adds, updates, removes and lists in arrival order', async () => {
    hold();
    const old = snapshot();
    const loading = loadAllTabs();
    emit({ type: 'tab.added', workspace_id: 'w1', tab: tab('new') } as MuxpadEvent);
    emit({ type: 'tab.updated', tab: tab('new', { name: 'renamed new' }) } as MuxpadEvent);
    mergeWorkspaceTabs('w1', [tab('new', { name: 'sidebar' }), tab('t1')]);
    emit({ type: 'tab.updated', tab: tab('new', { name: 'latest' }) } as MuxpadEvent);
    emit({ type: 'tab.removed', tab_id: 't1' } as MuxpadEvent);
    pending.shift()?.({ workspaces: old });
    await loading;
    await settle();
    expect(row('new')?.name).toBe('latest');
    expect(row('t1')).toBeUndefined();
    expect(row('t2')).toBeUndefined();
    expect(row('t3')).toBeDefined();
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });

  it('still retries an add whose workspace metadata is missing from the response', async () => {
    hold();
    const old = snapshot();
    const loading = loadAllTabs();
    SERVER = [...SERVER, { id: 'w3', slug: 'new', name: 'New', tabs: [tab('new')] }];
    emit({ type: 'tab.added', workspace_id: 'w3', tab: tab('new') } as MuxpadEvent);
    pending.shift()?.({ workspaces: old });
    await loading;
    await settle();
    expect(row('new')).toBeDefined();
    expect(listAllTabs).toHaveBeenCalledTimes(2);
  });

  it('bounds the replay journal and falls back to one fresh request on overflow', async () => {
    hold();
    const old = snapshot();
    const loading = loadAllTabs();
    for (let i = 0; i < 4100; i++)
      emit({ type: 'tab.updated', tab: tab('t2', { name: `push ${i}` }) } as MuxpadEvent);
    SERVER[0]!.tabs[1] = tab('t2', { name: 'server latest' });
    pending.shift()?.({ workspaces: old });
    await loading;
    await settle();
    expect(row('t2')?.name).toBe('server latest');
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

describe('the slim per-workspace list must not rob the corpus of report text', () => {
  /**
   * `GET /api/tabs?workspaceId=` omits `spawn_report`'s TEXT — it was 56.5% of
   * a 1.19 MB answer on the route the sidebar re-polls after every status edge
   * (server/src/tab-list.ts). `/api/tabs/all` still carries it, because the
   * corpus is what renders a spawn card.
   *
   * So the merge of those slim rows is the exact place the text can be lost,
   * and losing it is SILENT: the card falls back to "Finished with nothing to
   * report", which is indistinguishable from a worker that really produced
   * nothing. Caught in review, not by these tests, which is why they exist.
   */
  it('keeps the text the corpus already had when the fresh row has none', async () => {
    SERVER = [
      {
        id: 'w1',
        slug: 'personal',
        name: 'Personal',
        tabs: [tab('t1', { spawn_report: 'what the worker did', spawn_report_state: 'ok' })],
      },
    ];
    await loadAllTabs();
    // The sidebar's 5s poll lands: same row, renamed, and no report text.
    mergeWorkspaceTabs('w1', [tab('t1', { name: 'renamed', spawn_report_state: 'ok' })]);
    expect(row('t1')?.name).toBe('renamed');
    expect(row('t1')?.spawn_report).toBe('what the worker did');
  });

  it('takes the fresh text when the fresh row HAS some', async () => {
    SERVER = [
      { id: 'w1', slug: 'personal', name: 'Personal', tabs: [tab('t1', { spawn_report: 'old' })] },
    ];
    await loadAllTabs();
    mergeWorkspaceTabs('w1', [tab('t1', { spawn_report: 'new' })]);
    expect(row('t1')?.spawn_report).toBe('new');
  });

  it('invents nothing for a row that never had any', async () => {
    SERVER = [{ id: 'w1', slug: 'personal', name: 'Personal', tabs: [tab('t1')] }];
    await loadAllTabs();
    mergeWorkspaceTabs('w1', [tab('t1', { name: 'renamed' })]);
    expect(row('t1')?.spawn_report).toBeUndefined();
    expect(row('t1')?.name).toBe('renamed');
  });

  it('does not scan the held rows once per fresh row', async () => {
    // It did: `held.find(...)` inside `tabs.map` — O(n²), ~1.4 million
    // comparisons on a 1,200-row workspace, 20–30 ms per landing, on a merge
    // that runs whenever a poll lands. Caught by review one commit after I
    // fixed the identical shape on the server (0aff773b).
    //
    // A timing assertion would be flaky, so this pins the SHAPE: the held
    // rows are turned into a Map once, outside the map over fresh rows.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'all-tabs.ts'), 'utf8');
    const fn = /export function mergeWorkspaceTabs[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    // The held rows become a Map ONCE…
    expect(fn).toMatch(/new Map\(group\.tabs\.map/);
    // …and the per-row helper takes that Map, so it cannot scan.
    // (A blanket ban on `.find` would be wrong: this function legitimately
    // finds the group among the two or three workspaces.)
    expect(fn).toMatch(/keepReportText\(t, heldById\)/);
    const helper = /function keepReportText[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(helper).toMatch(/heldById\.get\(/);
    expect(helper).not.toMatch(/\.find\(/);
  });

  it('still publishes nothing when only the dropped text differs', async () => {
    // The dedupe above it is load-bearing: without it the 5s poll would
    // re-publish the corpus every 5s and re-render every reader, ChatPane
    // included. Preserving the text must not defeat that.
    SERVER = [
      { id: 'w1', slug: 'personal', name: 'Personal', tabs: [tab('t1', { spawn_report: 'x' })] },
    ];
    await loadAllTabs();
    const seen: WorkspaceTabs[][] = [];
    subscribeAllTabs((g) => seen.push(g));
    const before = seen.length;
    mergeWorkspaceTabs('w1', [tab('t1')]);
    expect(seen.length).toBe(before);
  });
});

describe('corpus equality without serialized signatures', () => {
  it('compares unchanged polls without serializing report text', async () => {
    SERVER[0]!.tabs = [tab('t1', { spawn_report: 'report'.repeat(10_000) })];
    await loadAllTabs();
    const held = cachedAllTabs();
    const incoming = structuredClone(SERVER[0]!.tabs);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      mergeWorkspaceTabs('w1', incoming);
      expect(cachedAllTabs()).toBe(held);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('stops reading rows after the first visible difference', async () => {
    await loadAllTabs();
    const later = tab('t2');
    const read = vi.fn(() => 't2');
    Object.defineProperty(later, 'name', { enumerable: true, get: read });
    mergeWorkspaceTabs('w1', [tab('t1', { name: 'new name' }), later]);
    expect(row('t1')?.name).toBe('new name');
    expect(read).not.toHaveBeenCalled();
  });

  it('ignores key insertion order and absent undefined fields but catches nested changes', async () => {
    await loadAllTabs();
    const held = cachedAllTabs();
    mergeWorkspaceTabs(
      'w1',
      SERVER[0]!.tabs.map(
        (t) =>
          ({
            extra: undefined,
            ...Object.fromEntries(Object.entries(t).reverse()),
          }) as unknown as Tab,
      ),
    );
    expect(cachedAllTabs()).toBe(held);
    mergeWorkspaceTabs('w1', [
      tab('t1', { layout: { direction: 'row', first: 'a', second: 'b' } as never }),
      tab('t2'),
    ]);
    expect(cachedAllTabs()).not.toBe(held);
  });
});

describe('the structural corpus stays narrower than workspace history', () => {
  it('filters workspace snapshots while retaining retired owners of live work', async () => {
    await loadAllTabs();
    mergeWorkspaceTabs('w1', [
      tab('history', { done: true, corpus_live: false }),
      tab('retired-owner', { done: true, status: 'idle', corpus_live: true }),
      tab('live', { corpus_live: true }),
      tab('excluded-working', { status: 'working', corpus_live: false }),
    ]);
    expect(
      cachedAllTabs()
        ?.find((g) => g.id === 'w1')
        ?.tabs.map((t) => t.id),
    ).toEqual(['retired-owner', 'live']);
  });

  it('ejects a row on an SSE false and restores a revived owner with explicit workspace placement', async () => {
    await loadAllTabs();
    const seen = vi.fn();
    subscribeAllTabs(seen);
    emit({ type: 'tab.updated', tab: tab('t2', { corpus_live: false }) } as MuxpadEvent);
    expect(row('t2')).toBeUndefined();
    emit({
      type: 'tab.updated',
      workspace_id: 'w1',
      tab: tab('t2', { corpus_live: true, done: true, status: 'idle' }),
    } as MuxpadEvent);
    expect(row('t2')).toMatchObject({ corpus_live: true, done: true });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });

  it('does not publish or refetch for historical adds and updates outside the corpus', async () => {
    await loadAllTabs();
    const held = cachedAllTabs();
    const seen = vi.fn();
    subscribeAllTabs(seen);
    emit({
      type: 'tab.added',
      workspace_id: 'w1',
      tab: tab('old', { corpus_live: false }),
    } as MuxpadEvent);
    emit({
      type: 'tab.added',
      workspace_id: 'unknown',
      tab: tab('old2', { corpus_live: false }),
    } as MuxpadEvent);
    emit({ type: 'tab.updated', tab: tab('old', { corpus_live: false }) } as MuxpadEvent);
    await loadAllTabs();
    expect(cachedAllTabs()).toBe(held);
    expect(seen).not.toHaveBeenCalled();
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });

  it('filters first-load replay and applies membership flips in arrival order without another fetch', async () => {
    let release!: (v: { workspaces: WorkspaceTabs[] }) => void;
    const snapshot = structuredClone(SERVER);
    listAllTabs.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const loading = loadAllTabs();
    mergeWorkspaceTabs('w1', [
      tab('t1', { corpus_live: true }),
      tab('old', { done: true, corpus_live: false }),
    ]);
    emit({ type: 'tab.updated', tab: tab('t1', { corpus_live: false }) } as MuxpadEvent);
    emit({
      type: 'tab.added',
      workspace_id: 'w1',
      tab: tab('old', { corpus_live: false }),
    } as MuxpadEvent);
    emit({
      type: 'tab.updated',
      workspace_id: 'w1',
      tab: tab('revived', { corpus_live: true, done: true }),
    } as MuxpadEvent);
    release({ workspaces: snapshot });
    await loading;
    expect(
      cachedAllTabs()
        ?.find((g) => g.id === 'w1')
        ?.tabs.map((t) => t.id),
    ).toEqual(['revived']);
    expect(row('revived')?.done).toBe(true);
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });

  it('also rejects explicitly excluded rows from a fetched snapshot', async () => {
    SERVER[0]!.tabs = [
      tab('old', { corpus_live: false }),
      tab('owner', { done: true, corpus_live: true }),
    ];
    await loadAllTabs();
    expect(row('old')).toBeUndefined();
    expect(row('owner')).toBeDefined();
  });
});
