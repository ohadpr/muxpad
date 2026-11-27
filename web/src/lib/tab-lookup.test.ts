import type { Tab } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WorkspaceTabs, rankTabs, toSearchableTabs } from './nav-search';

const tab = (id: string, layout: string, over: Partial<Tab> = {}): Tab =>
  ({ id, slug: id, name: id, layout, created_at: 1, updated_at: 1, ...over }) as Tab;

type By = { q: string } | { paneIds: readonly string[] } | { tabIds: readonly string[] };
const calls: By[] = [];
let answer: (by: By) => Promise<{ workspaces: WorkspaceTabs[] }> = async () => ({
  workspaces: [],
});
vi.mock('../api', () => ({
  api: {
    lookupTabs: (by: By) => {
      calls.push(by);
      return answer(by);
    },
  },
}));

const {
  LOOKUP_MAX_PANE_IDS,
  LOOKUP_MAX_ROWS,
  lookupCacheSizes,
  lookupGroups,
  lookupPanesPending,
  lookupQueryPending,
  mergeTabGroups,
  rankLiveThenHistory,
  requestLookupPanes,
  requestLookupQuery,
  requestLookupTabIds,
  lookupTabsPending,
  resetTabLookup,
  retainTabIds,
} = await import('./tab-lookup');

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const ids = (groups: readonly WorkspaceTabs[]) => groups.flatMap((g) => g.tabs.map((t) => t.id));
const ws = (id: string, tabs: Tab[]): WorkspaceTabs => ({ id, slug: id, name: id, tabs });

beforeEach(() => {
  resetTabLookup();
  calls.length = 0;
  answer = async () => ({ workspaces: [] });
});
afterEach(() => resetTabLookup());

describe('mergeTabGroups — the live corpus, with history folded under it', () => {
  it('returns the live array ITSELF when there is nothing to add', () => {
    const live = [ws('w1', [tab('a', 'pa')])];
    expect(mergeTabGroups(live, [])).toBe(live);
    // …and when every looked-up row is already live.
    expect(mergeTabGroups(live, [ws('w1', [tab('a', 'pa', { name: 'stale' })])])).toBe(live);
  });

  it('the live row wins; finished rows join their workspace, or a new one', () => {
    const live = [ws('w1', [tab('a', 'pa', { name: 'live name' })])];
    const out = mergeTabGroups(live, [
      ws('w1', [tab('a', 'pa', { name: 'snapshot' }), tab('old', 'po', { done: true })]),
      ws('w2', [tab('far', 'pf', { done: true })]),
    ]);
    expect(out.map((g) => g.id)).toEqual(['w1', 'w2']);
    expect(ids(out)).toEqual(['a', 'old', 'far']);
    expect(out[0]?.tabs[0]?.name).toBe('live name');
    // The live array is not mutated.
    expect(ids(live)).toEqual(['a']);
  });
});

describe('name lookup — bounded, cached, never in front of the instant tier', () => {
  it('asks once per query and serves the held answer after', async () => {
    answer = async () => ({ workspaces: [ws('w1', [tab('invoices', 'p1', { done: true })])] });
    expect(lookupQueryPending('Invo')).toBe(true);
    requestLookupQuery('Invo');
    requestLookupQuery('invo '); // same key: trimmed, case-folded, already travelling
    await flush();
    expect(calls).toEqual([{ q: 'Invo' }]);
    expect(lookupQueryPending('invo')).toBe(false);
    expect(ids(lookupGroups({ query: 'invo' }))).toEqual(['invoices']);
    requestLookupQuery('invo');
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('does not ask for an empty query', async () => {
    requestLookupQuery('');
    requestLookupQuery('   ');
    await flush();
    expect(calls).toEqual([]);
    expect(lookupQueryPending('')).toBe(false);
  });

  it('resolves a single-character name in finished history', async () => {
    answer = async () => ({
      workspaces: [ws('history', [tab('x', 'px', { name: 'X', done: true })])],
    });
    requestLookupQuery('X');
    await flush();
    expect(calls).toEqual([{ q: 'X' }]);
    expect(ids(lookupGroups({ query: 'x' }))).toEqual(['x']);
  });

  it('a longer query is answered by its held prefix until its own answer lands', async () => {
    answer = async () => ({ workspaces: [ws('w1', [tab('invoices', 'p1')])] });
    requestLookupQuery('inv');
    await flush();
    expect(ids(lookupGroups({ query: 'invoice' }))).toEqual(['invoices']);
    // An unrelated query gets nothing from it.
    expect(ids(lookupGroups({ query: 'bravo' }))).toEqual([]);
  });

  it('an older server (404) is learned once, then never asked again', async () => {
    answer = async () => Promise.reject(Object.assign(new Error('404'), { status: 404 }));
    requestLookupQuery('alpha');
    await flush();
    requestLookupQuery('bravo');
    requestLookupPanes(['p1']);
    await flush();
    expect(calls).toEqual([{ q: 'alpha' }]);
    expect(lookupQueryPending('bravo')).toBe(false);
  });
});

describe('pane lookup — an archive hit finds its finished chat', () => {
  it('batches one tick of asks into one request and resolves by layout leaf', async () => {
    answer = async () => ({
      workspaces: [ws('w1', [tab('old', 'p2', { done: true })])],
    });
    requestLookupPanes(['p1']);
    requestLookupPanes(['p2', 'p1']);
    expect(lookupPanesPending(['p1'])).toBe(true);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ paneIds: ['p1', 'p2'] });
    expect(ids(lookupGroups({ paneIds: ['p2'] }))).toEqual(['old']);
    expect(lookupPanesPending(['p1', 'p2'])).toBe(false);
  });

  it('a pane the server does not know is not asked about again', async () => {
    requestLookupPanes(['gone']);
    await flush();
    requestLookupPanes(['gone']);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it(`never sends more than ${LOOKUP_MAX_PANE_IDS} pane ids in one request`, async () => {
    const many = Array.from({ length: LOOKUP_MAX_PANE_IDS + 5 }, (_, i) => `p${i}`);
    requestLookupPanes(many);
    await flush();
    expect(calls.map((c) => ('paneIds' in c ? c.paneIds.length : 0))).toEqual([
      LOOKUP_MAX_PANE_IDS,
      5,
    ]);
  });

  it('a failed request is not a miss: the panes are asked about again', async () => {
    answer = async () => Promise.reject(new Error('offline'));
    requestLookupPanes(['p1']);
    await flush();
    requestLookupPanes(['p1']);
    await flush();
    expect(calls).toHaveLength(2);
  });
});

describe('a kept row outlives the query that found it', () => {
  it('is returned by tab id after the query is gone', async () => {
    answer = async () => ({ workspaces: [ws('w1', [tab('old', 'p1', { done: true })])] });
    requestLookupQuery('old chat');
    await flush();
    expect(ids(lookupGroups({ query: '' }))).toEqual([]);
    expect(ids(lookupGroups({ query: '', tabIds: ['old'] }))).toEqual(['old']);
  });
});

describe('rankLiveThenHistory — history never outranks a live match', () => {
  const live = toSearchableTabs([ws('w1', [tab('my quarterly plan', 'p1')])]);
  const history = toSearchableTabs([
    ws('w2', [tab('quarterly', 'p2', { done: true }), tab('my quarterly plan', 'p1')]),
  ]);
  const run = (limit: number) =>
    rankLiveThenHistory(
      live,
      history,
      (pool) => rankTabs(pool, 'quarterly', { limit }),
      (m) => m.tab.tabId,
      limit,
    ).map((m) => m.tab.tabId);

  it('live first even when a finished chat is the better name match; one row per chat', () => {
    // Merged, `quarterly` (exact) would outrank `my quarterly plan` (substring).
    expect(rankTabs([...live, history[0]!], 'quarterly', { limit: 5 })[0]?.tab.tabId).toBe(
      'quarterly',
    );
    expect(run(5)).toEqual(['my quarterly plan', 'quarterly']);
  });

  it('capped across both tiers — live fills the budget first', () => {
    expect(run(1)).toEqual(['my quarterly plan']);
  });
});

describe('exact tab-id lookup — a recorded reference, never a name', () => {
  it('batches, resolves by id, and remembers a miss', async () => {
    answer = async () => ({ workspaces: [ws('w1', [tab('t-old', 'p1', { done: true })])] });
    requestLookupTabIds(['t-old']);
    requestLookupTabIds(['t-gone', 't-old']);
    expect(lookupTabsPending(['t-old'])).toBe(true);
    await flush();
    expect(calls).toEqual([{ tabIds: ['t-old', 't-gone'] }]);
    expect(ids(lookupGroups({ tabIds: ['t-old', 't-gone'] }))).toEqual(['t-old']);
    requestLookupTabIds(['t-old', 't-gone']);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it(`never more than ${LOOKUP_MAX_PANE_IDS} ids per request`, async () => {
    requestLookupTabIds(Array.from({ length: LOOKUP_MAX_PANE_IDS + 1 }, (_, i) => `t${i}`));
    await flush();
    expect(calls.map((c) => ('tabIds' in c ? c.tabIds.length : 0))).toEqual([
      LOOKUP_MAX_PANE_IDS,
      1,
    ]);
  });
});

describe('the 600-row bound covers the pane index too', () => {
  const settle = async () => {
    for (let n = -1; n !== calls.length; ) {
      n = calls.length;
      await flush();
    }
  };
  it('an evicted row takes its panes with it; a re-held row drops its old layout’s panes', async () => {
    answer = async (by) => ({
      workspaces: [
        ws(
          'w1',
          ('tabIds' in by ? by.tabIds : []).map((id) =>
            tab(id, id === 'moved' ? 'p-new' : `p-${id}`),
          ),
        ),
      ],
    });
    const many = Array.from({ length: LOOKUP_MAX_ROWS + 5 }, (_, i) => `t${i}`);
    requestLookupTabIds(many);
    await settle();
    expect(lookupCacheSizes()).toEqual({ rows: LOOKUP_MAX_ROWS, panes: LOOKUP_MAX_ROWS });
    // The oldest five are gone, and so is what their panes pointed at.
    expect(ids(lookupGroups({ paneIds: ['p-t0'] }))).toEqual([]);
    expect(ids(lookupGroups({ paneIds: [`p-t${LOOKUP_MAX_ROWS + 4}`] }))).toEqual([
      `t${LOOKUP_MAX_ROWS + 4}`,
    ]);

    resetTabLookup();
    answer = async () => ({ workspaces: [ws('w1', [tab('moved', 'p-old')])] });
    requestLookupTabIds(['moved']);
    await settle();
    answer = async () => ({ workspaces: [ws('w1', [tab('moved', 'p-new')])] });
    requestLookupPanes(['p-new']);
    await settle();
    expect(ids(lookupGroups({ paneIds: ['p-old'] }))).toEqual([]);
    expect(ids(lookupGroups({ paneIds: ['p-new'] }))).toEqual(['moved']);
    expect(lookupCacheSizes()).toEqual({ rows: 1, panes: 1 });
  });
});

/**
 * EVICTION MUST NOT QUIETLY DESTROY SOMETHING IN USE. Two failures a review
 * reproduced, both of which the bound's own tests could not see, because they
 * assert cache SIZE and the pane index — not what a live consumer still needs.
 */
describe('a row someone is still pointing at', () => {
  const settle = async () => {
    for (let n = -1; n !== calls.length; ) {
      n = calls.length;
      await flush();
    }
  };
  const fill = async (count: number) => {
    answer = async (by) => ({
      workspaces: [
        ws(
          'w1',
          ('tabIds' in by ? by.tabIds : []).map((id) => tab(id, `p-${id}`)),
        ),
      ],
    });
    requestLookupTabIds(Array.from({ length: count }, (_, i) => `filler${i}`));
    await settle();
  };

  it('survives the cache filling up — the pick in an open draft is the case', async () => {
    answer = async (by) => ({
      workspaces: [
        ws(
          'w1',
          ('tabIds' in by ? by.tabIds : []).map((id) => tab(id, `p-${id}`)),
        ),
      ],
    });
    requestLookupTabIds(['picked']);
    await settle();
    const release = retainTabIds(['picked']);

    // Everything else churns through: transcripts, searches, other panes.
    await fill(LOOKUP_MAX_ROWS + 50);
    // The whole point: sending now must still resolve the pick's context.
    expect(ids(lookupGroups({ tabIds: ['picked'] }))).toEqual(['picked']);

    // Let go, churn again, and it is ordinary cache content once more.
    release();
    await fill(LOOKUP_MAX_ROWS + 50);
    expect(ids(lookupGroups({ tabIds: ['picked'] }))).toEqual([]);
  });

  it('is refetched when it goes missing anyway', async () => {
    answer = async (by) => ({
      workspaces: [
        ws(
          'w1',
          ('tabIds' in by ? by.tabIds : []).map((id) => tab(id, `p-${id}`)),
        ),
      ],
    });
    requestLookupTabIds(['gone']);
    await settle();
    await fill(LOOKUP_MAX_ROWS + 50);
    expect(ids(lookupGroups({ tabIds: ['gone'] }))).toEqual([]);
    // Not a server miss — an eviction. Asking again must reach the server.
    const before = calls.length;
    requestLookupTabIds(['gone']);
    await settle();
    expect(calls.length).toBeGreaterThan(before);
    expect(ids(lookupGroups({ tabIds: ['gone'] }))).toEqual(['gone']);
  });

  it('does not report a query as answered once its rows have been evicted', async () => {
    answer = async (by) => ({
      workspaces: [
        ws(
          'w1',
          'q' in by
            ? [tab('hit', 'p-hit')]
            : ('tabIds' in by ? by.tabIds : []).map((id) => tab(id, `p-${id}`)),
        ),
      ],
    });
    requestLookupQuery('needle');
    await settle();
    expect(ids(lookupGroups({ query: 'needle' }))).toEqual(['hit']);

    // Churn the cache WITHOUT replacing `answer` — this test needs the query
    // to still be answerable when it is asked again.
    requestLookupTabIds(Array.from({ length: LOOKUP_MAX_ROWS + 50 }, (_, i) => `filler${i}`));
    await settle();
    expect(ids(lookupGroups({ query: 'needle' }))).toEqual([]);
    // The record is still inside its 30 s TTL. It must not be believed.
    const before = calls.length;
    requestLookupQuery('needle');
    await settle();
    expect(calls.length).toBeGreaterThan(before);
    expect(ids(lookupGroups({ query: 'needle' }))).toEqual(['hit']);
  });

  it('never retains more than the cap, so the exemption is bounded too', async () => {
    const many = Array.from({ length: 400 }, (_, i) => `keep${i}`);
    answer = async (by) => ({
      workspaces: [
        ws(
          'w1',
          ('tabIds' in by ? by.tabIds : []).map((id) => tab(id, `p-${id}`)),
        ),
      ],
    });
    requestLookupTabIds(many);
    await settle();
    retainTabIds(many);
    await fill(LOOKUP_MAX_ROWS + 300);
    // 600 ordinary rows plus at most 200 retained ones, never 400.
    expect(lookupCacheSizes().rows).toBeLessThanOrEqual(LOOKUP_MAX_ROWS + 200);
  });
});
