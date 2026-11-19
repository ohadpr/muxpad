// `act` from 'react', not 'react-dom/test-utils' — the latter is deprecated in
// 18.3 and logs a warning on every use.
import { type MuxpadEvent, MuxpadEventSchema, type Tab } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `tab.updated` has to reach the sidebar's ROWS, not just the workspace list.
 *
 * ─── What was broken ─────────────────────────────────────────────────────
 * The server emits `tab.updated` from a dozen places, and two of them exist
 * only to make a change visible NOW: HeadlineWriter (a new headline or icon
 * from a finished turn) and the activity recorder (a tab that just did
 * something). The client threw both on the floor as far as the tab list was
 * concerned — main.tsx handled the event with `refreshWorkspaces()` alone, and
 * this module subscribed to `pane.updated` / `pane.removed` and nothing else.
 * So a generated headline landed on the next 5s poll, exactly as it would have
 * with no event at all, and never at all for a workspace whose poll is stopped
 * (collapsed in the sidebar, or the document hidden).
 *
 * ─── What these tests hold ───────────────────────────────────────────────
 * They drive the real store through the real hook and a real React root,
 * because the property is "the row repaints", and a cache the renderer never
 * hears about is not a repaint. The event is the only input: no fetch is
 * allowed to happen, and `listTabs` is counted to prove it.
 */

// React 18 only drives updates inside `act` (rather than warning about it)
// once this global says the environment is a test one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listTabs = vi.fn(async () => rows);
vi.mock('./api', () => ({ api: { listTabs: () => listTabs(), listWorkspaces: async () => [] } }));

/** Every live subscriber, so a test can push an event into the store. */
const handlers = new Set<(e: MuxpadEvent) => void>();
vi.mock('./events', () => ({
  subscribe: (h: (e: MuxpadEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  subscribeReconnect: () => () => {},
  // This module now hands its landed lists to `lib/all-tabs`, which subscribes
  // here too. Never fired: these tests assert the push path costs no fetch.
  subscribeResync: () => () => {},
}));

const refreshWorkspaces = vi.fn(async () => {});
vi.mock('./workspaces', () => ({
  refreshWorkspaces: () => refreshWorkspaces(),
  // The rollup goes through the coalescer now (see refreshWorkspacesSoon).
  // Counted as a refresh here: this suite asserts what a live event asks for,
  // not when the timer lets it leave.
  refreshWorkspacesSoon: () => refreshWorkspaces(),
}));

const WS = 'ws_01';
const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({
    id,
    slug: id,
    name: id,
    layout: 'p',
    created_at: 1,
    updated_at: 1,
    ...over,
  }) as Tab;

/** What `listTabs` answers with. Reassigned per test. */
let rows: Tab[] = [];

/** The tab list the mounted hook last rendered. */
let seen: Tab[] = [];
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

/** Mount `useTabs(WS)` for real and record every list it renders. */
async function mount(useTabs: (ws: string) => { tabs: Tab[] }): Promise<void> {
  function Probe() {
    seen = useTabs(WS).tabs;
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<Probe />);
  });
}

/**
 * Push a `tab.updated` through the handlers, THROUGH THE REAL SCHEMA first.
 *
 * `MuxpadEventSchema.parse` is what the live socket runs (web/src/events.ts),
 * and it strips unknown keys — so parsing here is what keeps this file honest
 * about the one assumption the splice rests on: that the event carries a fully
 * decorated row. A hand-cast object would let the test keep passing after
 * `TabSchema` lost `headline` or `icon`, with the splice quietly blanking the
 * field on every client until the poll.
 */
const emitTab = async (t: Tab) => {
  const e = MuxpadEventSchema.parse({ type: 'tab.updated', tab: t });
  await act(async () => {
    for (const h of [...handlers]) h(e);
  });
};

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  listTabs.mockClear();
  refreshWorkspaces.mockClear();
  seen = [];
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('a tab.updated repaints the row it names', () => {
  it('shows a generated headline WITHOUT a refetch', async () => {
    rows = [tab('t1'), tab('t2')];
    const mod = await import('./tabs');
    await act(async () => {
      await mod.refreshTabs(WS);
    });
    await mount(mod.useTabs);
    expect(listTabs).toHaveBeenCalledTimes(1);

    await emitTab(tab('t2', { headline: 'wiring the cron scheduler into boot', icon: '⏱️' }));

    // The row the renderer holds, not merely the cache behind it.
    expect(seen.find((t) => t.id === 't2')?.headline).toBe('wiring the cron scheduler into boot');
    expect(seen.find((t) => t.id === 't2')?.icon).toBe('⏱️');
    // The event carries the whole decorated row, so there is nothing to go and
    // ask for. A refetch here would also be actively wrong — see the order test.
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('repaints the pushed row and leaves the order alone', async () => {
    // This used to assert the opposite — that the client RE-SORTED on the
    // push, so a row which had just become the most recently active one did
    // not have to wait for the next 5s poll (which is stopped for a collapsed
    // workspace or a hidden document). The order no longer ranks on activity
    // at all (shared/tab-order), so there is nothing to keep fresh; what is
    // left to get right is that the row still repaints without a refetch.
    rows = [
      tab('t1', { last_activity_at: 3_000 }),
      tab('t2', { last_activity_at: 2_000 }),
      tab('t3', { last_activity_at: 1_000 }),
    ];
    const mod = await import('./tabs');
    await act(async () => {
      await mod.refreshTabs(WS);
    });
    await mount(mod.useTabs);
    expect(seen.map((t) => t.id)).toEqual(['t1', 't2', 't3']);

    await emitTab(tab('t3', { headline: 'just did something', last_activity_at: 9_999 }));

    expect(seen.find((t) => t.id === 't3')?.headline).toBe('just did something');
    expect(seen.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('does not promote a tab that starts wanting you', async () => {
    // `blocked` is the agent parked on a question, and it used to jump to the
    // top of the list the moment it happened. It says so where it sits now:
    // the row wears `YOU` and a collapsed workspace carries the rollup. A row
    // that moves when its agent changes state is a row you cannot point at —
    // which is what OpenBot shipped, then shipped a switch to disable a day
    // later.
    rows = [
      tab('t1', { last_activity_at: 3_000 }),
      tab('t2', { last_activity_at: 2_000 }),
      tab('t3', { last_activity_at: 1_000 }),
    ];
    const mod = await import('./tabs');
    await act(async () => {
      await mod.refreshTabs(WS);
    });
    await mount(mod.useTabs);

    await emitTab(tab('t3', { status: 'blocked', last_activity_at: 1_000 }));

    expect(seen.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(seen.find((t) => t.id === 't3')?.status).toBe('blocked');
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('never moves a row out of the pinned block', async () => {
    // Pinned tabs carry a manual order and must stay above the divider whatever
    // their recency says — NavTree draws the divider at the pinned count.
    rows = [
      tab('p1', { pinned: true, last_activity_at: 1 }),
      tab('p2', { pinned: true, last_activity_at: 2 }),
      tab('t1', { last_activity_at: 3_000 }),
    ];
    const mod = await import('./tabs');
    await act(async () => {
      await mod.refreshTabs(WS);
    });
    await mount(mod.useTabs);

    await emitTab(tab('t1', { last_activity_at: 9_999 }));

    expect(seen.map((t) => t.id)).toEqual(['p1', 'p2', 't1']);
  });

  it('ignores a tab this workspace does not hold', async () => {
    rows = [tab('t1')];
    const mod = await import('./tabs');
    await act(async () => {
      await mod.refreshTabs(WS);
    });
    await mount(mod.useTabs);
    const before = seen;

    await emitTab(tab('elsewhere', { headline: 'nope' }));
    // Same array identity: no listener was called, so nothing re-rendered.
    expect(seen).toBe(before);

    // Paired with the positive, so this cannot pass by handling nothing.
    await emitTab(tab('t1', { headline: 'yes' }));
    expect(seen).not.toBe(before);
    expect(seen[0]?.headline).toBe('yes');
    expect(listTabs).toHaveBeenCalledTimes(1);
  });
});

describe('a PIN flip is the one change a patch cannot make', () => {
  it('refetches instead of splicing, so the divider stays put', async () => {
    // NavTree draws the pinned/unpinned divider at `tabs.filter(t => t.pinned)
    // .length`, so a row that becomes pinned WHERE IT IS puts the divider in
    // the wrong place. The server moves a newly-pinned tab to the end of the
    // pinned block, and only its list knows where that is.
    vi.useFakeTimers();
    try {
      rows = [tab('t1'), tab('t2')];
      const mod = await import('./tabs');
      await act(async () => {
        await mod.refreshTabs(WS);
      });
      await mount(mod.useTabs);
      expect(listTabs).toHaveBeenCalledTimes(1);

      rows = [tab('t2', { pinned: true }), tab('t1')];
      await emitTab(tab('t2', { pinned: true }));
      // Debounced with the pane.updated path, so nothing has gone out yet.
      expect(listTabs).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(listTabs).toHaveBeenCalledTimes(2);
      // …and the answer is the server's order, pinned row first.
      expect(seen.map((t) => t.id)).toEqual(['t2', 't1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queues the refetch when a splice supersedes it mid-flight', async () => {
    // `applyTabRow` bumps the per-workspace version so an older poll cannot
    // land on top of a newer event. That guard had a hole under it: a
    // superseded `refreshTabs` simply RETURNED, so the answer vanished. For
    // the pin path — where the refetch is the only thing that can fix the
    // divider — a single unrelated event arriving mid-flight left the list
    // wrong until the 5s poll, and forever with the poll stopped.
    //
    // Before this commit the hole was hard to reach (only a user's own drag
    // bumped the version); wiring tab.updated into the cache made ordinary
    // background traffic enter it.
    vi.useFakeTimers();
    try {
      rows = [tab('t1'), tab('t2')];
      const mod = await import('./tabs');
      await act(async () => {
        await mod.refreshTabs(WS);
      });
      await mount(mod.useTabs);

      // Hold the pin refetch open so an unrelated event can overtake it.
      let releaseFetch: (() => void) | null = null;
      listTabs.mockImplementationOnce(async () => {
        await new Promise<void>((r) => {
          releaseFetch = r;
        });
        return rows;
      });

      rows = [tab('t2', { pinned: true }), tab('t1')];
      await emitTab(tab('t2', { pinned: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(listTabs).toHaveBeenCalledTimes(2); // in flight, blocked

      // An ordinary headline for the OTHER row, arriving before it lands.
      await emitTab(tab('t1', { headline: 'unrelated' }));
      await act(async () => {
        (releaseFetch as unknown as () => void)();
        await vi.advanceTimersByTimeAsync(300);
      });

      // The superseded answer was discarded AND retried, so the order is right.
      expect(listTabs).toHaveBeenCalledTimes(3);
      expect(seen.map((t) => t.id)).toEqual(['t2', 't1']);
    } finally {
      vi.useRealTimers();
      listTabs.mockReset();
      listTabs.mockImplementation(async () => rows);
    }
  });
});

describe('a pushed row does not reorder the list', () => {
  it.each(['blocked', 'activity'] as const)('%s changing moves nothing', async (what) => {
    // The order is the one the server published and nothing here re-ranks it
    // (shared/tab-order). These are the two signals that USED to: a chat going
    // blocked was promoted above every idle one, and a newer activity stamp
    // climbed the list. B is published first, and after the push it is still
    // first — even though A is now the one that is blocked, or the one that is
    // most recently active.
    const a = tab('a', { last_activity_at: 100 });
    const b = tab('b', { last_activity_at: 200 });
    rows = [b, a];
    const mod = await import('./tabs');
    await mod.refreshTabs(WS);
    await mount(mod.useTabs);
    expect(seen.map((t) => t.id)).toEqual(['b', 'a']);

    const updated =
      what === 'blocked' ? { ...a, status: 'blocked' as const } : { ...a, last_activity_at: 9_999 };
    await emitTab(updated);
    expect(seen.map((t) => t.id)).toEqual(['b', 'a']);
    // …and the row itself DID update. A list that holds still by ignoring the
    // push would pass the assertion above and be the actual bug.
    expect(seen.find((t) => t.id === 'a')).toMatchObject(
      what === 'blocked' ? { status: 'blocked' } : { last_activity_at: 9_999 },
    );
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('appends a new chat rather than ranking it in', async () => {
    rows = [tab('b'), tab('a')];
    const mod = await import('./tabs');
    await mod.refreshTabs(WS);
    await mount(mod.useTabs);
    act(() => {
      mod.insertTabRow(WS, tab('zz', { last_activity_at: 9_999 }));
    });
    expect(seen.map((t) => t.id)).toEqual(['b', 'a', 'zz']);
  });

  it('keeps the pinned block contiguous, which the divider depends on', async () => {
    // NavTree draws the divider at `tabs.filter(t => t.pinned).length`, so a
    // pinned row left in the middle puts it in the wrong place.
    rows = [tab('loose'), tab('p', { pinned: true })];
    const mod = await import('./tabs');
    await mod.refreshTabs(WS);
    await mount(mod.useTabs);
    act(() => {
      mod.insertTabRow(WS, tab('p2', { pinned: true }));
    });
    expect(seen.map((t) => t.id)).toEqual(['p', 'p2', 'loose']);
  });
});
