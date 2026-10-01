// NAVIGATING TO A CHAT THE MOMENT IT EXISTS.
//
// "+ New tab" used to `await refreshTabs()` before navigating, which made the
// sidebar sit in `Creating…` for an extra round trip but did buy one thing: the
// per-workspace cache was guaranteed to contain the new tab before anything
// looked for its slug. Dropping that await to navigate immediately takes the
// guarantee away, and TabView is the consumer that needs it — it resolves
// `tabSlug` through `freshTabs`, which serves the cache WITHOUT a refetch while
// it is fresh (FRESH_MS = 2s). A list that landed a second before the create is
// fresh and has no such slug in it, and TabView's answer to a slug it cannot
// find is `setError('tab not found')` and a replace-navigate to the workspace
// root. The user taps New chat and is thrown out of the chat they just made.
//
// `insertTabRow` closes that window with the row the server just handed back.
// These are the assertions that it closes it, and that it cannot leave a ghost.
import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** What the server's tab list currently says. */
let WS_TABS: Tab[] = [];
const listTabs = vi.fn(async () => clone(WS_TABS));
vi.mock('./api', () => ({ api: { listTabs: () => listTabs() } }));

vi.mock('./events', () => ({
  subscribe: () => () => {},
  subscribeReconnect: () => () => {},
  subscribeResync: () => () => {},
}));
vi.mock('./workspaces', () => ({ refreshWorkspaces: async () => {} }));
vi.mock('./lib/all-tabs', () => ({
  mergeWorkspaceTabs: () => {},
  refreshCorpusForTab: () => {},
}));

const { cachedTabsFor, freshTabs, insertTabRow, refreshTabs } = await import('./tabs');

const WS = 'w1';
const COLD = 'w-never-loaded';

const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({
    id,
    slug: id,
    name: id,
    layout: 'p',
    created_at: 1,
    updated_at: 1,
    status: 'idle',
    done: false,
    ...over,
  }) as Tab;

beforeEach(() => {
  WS_TABS = [tab('t1'), tab('t2')];
  listTabs.mockClear();
});

describe('insertTabRow — the row the create call already answered with', () => {
  it('is visible to freshTabs without waiting for a refetch', async () => {
    // Land a list, so the cache is FRESH and `freshTabs` will not go back to
    // the server. This is the state the hazard needs: everything is current,
    // and current is exactly what does not contain a tab created since.
    await refreshTabs(WS);
    listTabs.mockClear();

    // The server creates t3 and answers with it. The socket push has not
    // arrived yet — that is the whole window.
    insertTabRow(WS, tab('t3'));

    const seen = await freshTabs(WS);
    expect(seen.map((t) => t.slug)).toContain('t3');
    // …and it did NOT have to ask. If this ever refetches, the window is being
    // closed by luck (a fast server) rather than by the splice.
    expect(listTabs).not.toHaveBeenCalled();
  });

  it('reaches the sidebar cache, not just the slug lookup', async () => {
    await refreshTabs(WS);
    insertTabRow(WS, tab('t3'));
    expect(cachedTabsFor(WS).map((t) => t.id)).toContain('t3');
  });

  // NOT asserted here: that the splice notifies `useTabs` subscribers, which is
  // what repaints an already-open sidebar. That path is only reachable through
  // the hook, this package has no react renderer in its test deps, and the line
  // is the same `listenersByWs` fan-out that applyTabRow / applyTabOrder /
  // applyTabUnread all already use. Left uncovered deliberately rather than
  // covered by a stand-in that proves something else.

  it('takes the UNDECORATED row the create response actually returns', async () => {
    // What `POST /api/tabs` answers with is the raw row plus workspace_id — no
    // `status`, no `agents`, no `clock`, none of the rollup `decorateTab` adds
    // to the GET. So the row spliced here is a different shape from its
    // neighbours for the one round trip before the push replaces them all, and
    // it has to sort and survive in that state rather than throw on a missing
    // field. (All three are `.optional()` on the wire type, and the
    // comparators are null-guarded — this pins that it stays true.)
    await refreshTabs(WS);
    const raw = {
      id: 't3',
      slug: 't3',
      name: 'New chat',
      layout: 'p',
      created_at: 9,
      updated_at: 9,
    };
    insertTabRow(WS, raw as unknown as Tab);
    const list = cachedTabsFor(WS);
    expect(list.map((t) => t.id)).toContain('t3');
    expect(list).toHaveLength(3);
  });

  it('is idempotent when the tab.added push gets there first', async () => {
    await refreshTabs(WS);
    insertTabRow(WS, tab('t3'));
    insertTabRow(WS, tab('t3'));
    expect(cachedTabsFor(WS).filter((t) => t.id === 't3')).toHaveLength(1);
  });

  it('survives an in-flight refresh that started before the create', async () => {
    // The ordering that would silently drop the row: a poll reads the list
    // (without t3), the create lands and splices t3 in, then the poll's answer
    // arrives and overwrites the cache with its older truth. The version bump
    // in insertTabRow is what makes the stale answer lose.
    await refreshTabs(WS);
    let release: (() => void) | undefined;
    listTabs.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return clone(WS_TABS); // the pre-create list
    });
    const inflight = refreshTabs(WS);
    await Promise.resolve();

    insertTabRow(WS, tab('t3'));
    release?.();
    await inflight;

    expect(cachedTabsFor(WS).map((t) => t.id)).toContain('t3');
  });

  it('does not invent a cache for a workspace that has none', () => {
    // A workspace nothing has mounted holds no list, so there is no stale
    // answer to correct — and fabricating a one-tab list here would be a real
    // ghost: `freshTabs` would serve it as the workspace's whole contents.
    insertTabRow(COLD, tab('t9'));
    expect(cachedTabsFor(COLD)).toEqual([]);
  });

  it('leaves nothing behind when the create never succeeded', async () => {
    // Not a test of insertTabRow so much as of its contract: it is only ever
    // reached with a 201 body, so a thrown create inserts nothing. Asserted
    // because "a phantom row that outlives a failed create" is strictly worse
    // than the wait this change removed.
    await refreshTabs(WS);
    const before = cachedTabsFor(WS).map((t) => t.id);
    const create = async () => {
      throw new Error('500');
    };
    await expect(create()).rejects.toThrow();
    expect(cachedTabsFor(WS).map((t) => t.id)).toEqual(before);
  });
});
