// `act` from 'react', not 'react-dom/test-utils' — the latter is deprecated in
// 18.3 and logs a warning on every use.
import type { MuxpadEvent, Tab } from '@muxpad/shared';
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

const emit = async (e: MuxpadEvent) => {
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

    await emit({
      type: 'tab.updated',
      tab: tab('t2', { headline: 'wiring the cron scheduler into boot', icon: '⏱️' }),
    } as MuxpadEvent);

    // The row the renderer holds, not merely the cache behind it.
    expect(seen.find((t) => t.id === 't2')?.headline).toBe('wiring the cron scheduler into boot');
    expect(seen.find((t) => t.id === 't2')?.icon).toBe('⏱️');
    // The event carries the whole decorated row, so there is nothing to go and
    // ask for. A refetch here would also be actively wrong — see the order test.
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('leaves the ARRAY ORDER exactly as the server gave it', async () => {
    // The server owns the order (pinned block, then attention → recency) and
    // this module only ever renders the sequence it was handed. `tab.updated`
    // also fires on every `last_activity_at` write, so a handler that refetched
    // would have re-sorted the unpinned block on every finished turn — rows
    // sliding under the cursor at the debounce rate, which is the exact thing
    // the active-tab freeze exists to prevent and which the freeze only covers
    // for ONE row. Patching in place cannot reorder anything.
    rows = [tab('t1'), tab('t2'), tab('t3')];
    const mod = await import('./tabs');
    await act(async () => {
      await mod.refreshTabs(WS);
    });
    await mount(mod.useTabs);

    await emit({
      type: 'tab.updated',
      tab: tab('t3', { headline: 'just did something', last_activity_at: 9_999 }),
    } as MuxpadEvent);

    // The update landed (without which the order assertion above is satisfied
    // by doing nothing at all) and it landed WHERE THE ROW ALREADY WAS.
    expect(seen.find((t) => t.id === 't3')?.headline).toBe('just did something');
    expect(seen.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(listTabs).toHaveBeenCalledTimes(1);
  });

  it('ignores a tab this workspace does not hold', async () => {
    rows = [tab('t1')];
    const mod = await import('./tabs');
    await act(async () => {
      await mod.refreshTabs(WS);
    });
    await mount(mod.useTabs);
    const before = seen;

    await emit({ type: 'tab.updated', tab: tab('elsewhere', { headline: 'nope' }) } as MuxpadEvent);
    // Same array identity: no listener was called, so nothing re-rendered.
    expect(seen).toBe(before);

    // Paired with the positive, so this cannot pass by handling nothing.
    await emit({ type: 'tab.updated', tab: tab('t1', { headline: 'yes' }) } as MuxpadEvent);
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
      await emit({ type: 'tab.updated', tab: tab('t2', { pinned: true }) } as MuxpadEvent);
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
});
