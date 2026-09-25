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
}));

const refreshWorkspaces = vi.fn(async () => {});
vi.mock('./workspaces', () => ({ refreshWorkspaces: () => refreshWorkspaces() }));

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

  it('RE-SORTS on the pushed row, without a refetch', async () => {
    // The order used to be left exactly as the server gave it, on the reasoning
    // that the server owns it. The cost was that a tab which had just become the
    // most recently active one did not move until the next 5s poll — and not at
    // all while that poll is stopped, which it is for a collapsed workspace or a
    // hidden document. The hazard that reasoning was protecting against (rows
    // sliding under the cursor) is `freezeActiveTab`'s job, one row wide.
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

    // The row repainted AND climbed — and the climb cost no round trip, because
    // both sides run the same comparator.
    expect(seen.find((t) => t.id === 't3')?.headline).toBe('just did something');
    expect(seen.map((t) => t.id)).toEqual(['t3', 't1', 't2']);
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('promotes a tab that starts wanting you, above a more recent one', async () => {
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

    // `blocked` is the agent parked on a question — the highest-value case
    // there is, and the one that must not wait for a poll.
    await emitTab(tab('t3', { status: 'blocked', last_activity_at: 1_000 }));

    expect(seen.map((t) => t.id)).toEqual(['t3', 't1', 't2']);
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

describe('pushed ties match authoritative ordering', () => {
  it.each(['blocked clears', 'activity ties'] as const)(
    '%s uses the same tie-break as GET',
    async (transition) => {
      const { compareUnpinnedTabs } = await import('@muxpad/shared');
      // Manual and previously published order are B,A, opposite to wire IDs.
      // After the push, attention and activity are equal: ONLY the tie-break
      // can put A first. Schema parsing ensures these are actual wire fields.
      const a = tab('a', { last_activity_at: transition === 'activity ties' ? 100 : null });
      const b = tab('b', {
        last_activity_at: transition === 'activity ties' ? 200 : null,
        status: transition === 'blocked clears' ? 'blocked' : 'idle',
      });
      const manual = new Map([
        ['b', 0],
        ['a', 1],
      ]);
      rows = [a, b].sort((x, y) => compareUnpinnedTabs(x, y, manual));
      expect(rows.map((t) => t.id)).toEqual(['b', 'a']);
      const mod = await import('./tabs');
      await mod.refreshTabs(WS);
      await mount(mod.useTabs);
      const updated =
        transition === 'activity ties'
          ? { ...a, last_activity_at: 200 }
          : { ...b, status: 'idle' as const };
      await emitTab(updated);
      rows = [a, b]
        .map((t) => (t.id === updated.id ? updated : t))
        .sort((x, y) => compareUnpinnedTabs(x, y, manual));
      // Pin GET's contract explicitly too: client == server alone could let
      // both sides agree on the same incorrect manual/index-based order.
      expect(rows.map((t) => t.id)).toEqual(['a', 'b']);
      expect(seen.map((t) => t.id)).toEqual(['a', 'b']);
      expect(seen).toEqual(rows);
      expect(listTabs).toHaveBeenCalledTimes(1);
      await act(async () => {
        await mod.refreshTabs(WS);
      });
      expect(seen).toEqual(rows);
    },
  );
});
