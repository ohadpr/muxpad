import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTabs } from './lib/nav-search';

/**
 * THE SIDEBAR, THE COUNT AND THE CARDS AGREE — ACROSS A DROPPED SOCKET.
 *
 * This is the assertion nobody had, and three separate staleness failures were
 * seen on the live cockpit before it existed. It spans two modules on purpose,
 * because the defect was never inside either one:
 *
 *   `tabs.ts`      the sidebar's per-workspace cache. Polls every 5s while
 *                  visible, refetches on a pane status edge, refetches on
 *                  reconnect. RECOVERS ON ITS OWN.
 *   `lib/all-tabs` the cross-workspace corpus behind the cards, the `@` picker
 *                  and the agent count. Push-only, no poll, by design.
 *                  DID NOT RECOVER — from anything, ever.
 *
 * Two clocks over one truth, so the surfaces disagreed: rows moved into the
 * done drawer while the cards beside them still claimed those chats were
 * running, and a phone whose socket died held "2 agents" until it was reloaded.
 *
 * Both halves are driven REAL here — real stores, real events, real
 * `runningChildren`/`liveStatusLabel` — with only the socket and the HTTP layer
 * faked, because the property under test is that the two modules reach the same
 * answer. A test that asserted on either one alone is exactly what passed
 * through all three failures.
 */

let WS_TABS: Tab[] = [];
let CORPUS: WorkspaceTabs[] = [];

// Cloned on the way out, exactly as a real fetch would be: every response is
// freshly parsed JSON, so nothing downstream may rely on object identity with
// what the test set up. Returning the same array made an identity assertion
// pass for a reason that does not exist in the product.
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const listTabs = vi.fn(async () => clone(WS_TABS));
const listAllTabs = vi.fn(async () => ({ workspaces: clone(CORPUS) }));
vi.mock('./api', () => ({
  api: { listTabs: () => listTabs(), listAllTabs: () => listAllTabs() },
}));

/** Live event subscribers, and the reconnect/resync channel the drop fires. */
const handlers = new Set<(e: MuxpadEvent) => void>();
const resyncHandlers = new Set<() => void>();
vi.mock('./events', () => ({
  subscribe: (h: (e: MuxpadEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  // A real reconnect fires both channels, so both land in one set here.
  subscribeReconnect: (h: () => void) => {
    resyncHandlers.add(h);
    return () => resyncHandlers.delete(h);
  },
  subscribeResync: (h: () => void) => {
    resyncHandlers.add(h);
    return () => resyncHandlers.delete(h);
  },
}));

vi.mock('./workspaces', () => ({ refreshWorkspaces: async () => {} }));

const { cachedTabsFor, refreshTabs } = await import('./tabs');
const { cachedAllTabs, loadAllTabs, resetAllTabsCache } = await import('./lib/all-tabs');
const { liveStatusLabel, runningChildren } = await import('./lib/live-status');

const WS = 'w1';
/** A workspace the sidebar never loads — only the corpus holds it. */
const OTHER = 'w2';

/** A live clock, as the server publishes one. `fill` moves on every read. */
const CLOCK = {
  started_at: 1_790_697_984_000,
  expires_at: 1_791_043_584_000,
  fill: 0.1,
  last_day: false,
  stopped: false,
};

const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({
    id,
    slug: id,
    name: id,
    layout: 'p',
    created_at: 1,
    updated_at: 1,
    status: 'working',
    done: false,
    clock: CLOCK,
    ...over,
  }) as Tab;

/** Two workers, both at it. */
const BUSY = () => [tab('t1'), tab('t2')];
/** …and both finished: the runner went idle and the chats decayed into done. */
const FINISHED = () => [
  tab('t1', { status: 'idle', done: true, done_reason: 'delivered' }),
  tab('t2', { status: 'idle', done: true, done_reason: 'delivered' }),
];

/** The corpus rows for the workspace under test — what the cards read. */
const corpusRows = (): Tab[] => cachedAllTabs()?.find((g) => g.id === WS)?.tabs ?? [];

/** The composer's live cell, derived exactly as ChatPane derives it. */
const agentLabel = (): string | null =>
  liveStatusLabel({ chats: runningChildren(corpusRows()).length });

const fireResync = () => {
  for (const h of [...resyncHandlers]) h();
};

/** Let the refetch chains settle — several `.then` hops plus a macrotask. */
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** The corpus as the server would answer it: BOTH workspaces. */
const corpusOf = (tabs: Tab[]): WorkspaceTabs[] => [
  { id: WS, slug: 'muxpad', name: 'muxpad', tabs },
  // A second workspace the SIDEBAR never loads — `refreshTabs` is only ever
  // called for `WS` here, exactly as the rail only mounts `useTabs` for the
  // workspaces it has expanded. The corpus is wider than the sidebar, and that
  // gap is its own row in the table.
  { id: OTHER, slug: 'other', name: 'Other', tabs: [tab('t3')] },
];

/** Bring both caches up on the same truth, the way a loaded page has them. */
async function boot(): Promise<void> {
  WS_TABS = BUSY();
  CORPUS = corpusOf(BUSY());
  await loadAllTabs();
  await refreshTabs(WS);
}

beforeEach(async () => {
  resetAllTabsCache();
  // `handlers` is deliberately NOT cleared: both stores subscribe once, at
  // import, and clearing the set would unregister them for every later test.
  listTabs.mockClear();
  listAllTabs.mockClear();
  // The module-level subscriptions of both stores are already registered; only
  // the per-test caches need clearing, which `refreshTabs` does by landing.
  await boot();
  listTabs.mockClear();
  listAllTabs.mockClear();
});

describe('a dropped-and-restored socket leaves every surface correct, with no reload', () => {
  it('starts with the sidebar, the corpus and the count agreeing', () => {
    expect(cachedTabsFor(WS).map((t) => t.status)).toEqual(['working', 'working']);
    expect(corpusRows().map((t) => t.status)).toEqual(['working', 'working']);
    expect(agentLabel()).toBe('2 agents');
  });

  it('heals the corpus, the sidebar and the count after a gap that pushed nothing', async () => {
    // THE OBSERVED FAILURE. The socket drops; while it is down both workers
    // finish. The server emits `pane.updated` for the status flip — which is
    // not delivered, and which carries no tab row anyway — and events are never
    // replayed on reconnect. So NO event reaches the client for this change:
    // the only route back to the truth is a refetch.
    WS_TABS = FINISHED();
    CORPUS = corpusOf(FINISHED());

    fireResync();
    await settle();

    // The sidebar recovered before this change too; it is here so that a
    // regression which breaks BOTH cannot pass by making them agree on stale.
    expect(cachedTabsFor(WS).every((t) => t.done)).toBe(true);
    // The corpus is the half that never recovered.
    expect(corpusRows().map((t) => t.status)).toEqual(['idle', 'idle']);
    expect(corpusRows().every((t) => t.done)).toBe(true);
    // And the three surfaces that disagreed now cannot.
    expect(runningChildren(corpusRows())).toEqual([]);
    expect(agentLabel()).toBe(null);
  });

  it('notifies the mounted readers rather than only mutating the cache', async () => {
    // A card holds its corpus in React state; a cache that heals silently
    // leaves the pixels exactly as stale as before.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const seen: WorkspaceTabs[][] = [];
    const off = subscribeAllTabs((g) => seen.push(g));
    WS_TABS = FINISHED();
    CORPUS = corpusOf(FINISHED());

    fireResync();
    await settle();
    off();

    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen
        .at(-1)
        ?.find((g) => g.id === WS)
        ?.tabs.every((t) => t.done),
    ).toBe(true);
  });

  it('does not repaint when the refetch finds nothing changed', async () => {
    // `subscribeResync` fires on every document-visible, which on a desktop is
    // every time the user switches app and comes back. The FETCH is right —
    // that is how a gap heals — but publishing its answer unconditionally
    // repaints every corpus reader, `ChatPane` included, on each switch even
    // when the answer is identical. The refetch is cheap; the repaint is not.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const seen: WorkspaceTabs[][] = [];
    const off = subscribeAllTabs((g) => seen.push(g));
    fireResync();
    await settle();
    off();
    expect(listAllTabs).toHaveBeenCalled(); // it DID go and look…
    expect(seen).toEqual([]); // …and found nothing worth a repaint.
  });

  it('keeps the same array identity when nothing changed, so React bails out', async () => {
    const before = cachedAllTabs();
    fireResync();
    await settle();
    // Not merely deep-equal — the SAME object, which is what lets a memo or a
    // `useState` comparison short-circuit instead of re-rendering.
    expect(cachedAllTabs()).toBe(before);
  });

  it('refetches even when the corpus is fresh by its own clock', async () => {
    // `loadAllTabs` short-circuits under FRESH_MS, and the corpus here landed
    // milliseconds ago. Fresh by that clock, stale by the only one that
    // matters — the gap. Without the `settledAt` reset the resync is a no-op.
    fireResync();
    await settle();
    expect(listAllTabs).toHaveBeenCalled();
  });
});

describe('the corpus keeps the laziness it was built for', () => {
  it('does not fetch a corpus nobody has asked for, even on reconnect', async () => {
    resetAllTabsCache();
    listAllTabs.mockClear();
    fireResync();
    await settle();
    // The whole reason this module is lazy is the mobile first paint: a
    // reconnect must not be what starts a corpus.
    expect(listAllTabs).not.toHaveBeenCalled();
    expect(cachedAllTabs()).toBeNull();
  });

  it('adds no request of its own to the sidebar refresh it rides', async () => {
    WS_TABS = FINISHED();
    await refreshTabs(WS);
    // The corpus moved on the strength of a list the sidebar was fetching
    // anyway. If this ever costs a `/api/tabs/all`, the poll this module exists
    // to avoid has arrived through the back door.
    expect(listAllTabs).not.toHaveBeenCalled();
    expect(corpusRows().every((t) => t.done)).toBe(true);
  });
});

describe('the two surfaces share one clock', () => {
  it('moves the cards when the sidebar poll lands, with no tab.updated at all', async () => {
    // THE HEALTHY-SOCKET FAILURE, and the subtler of the two. A pane going
    // working → idle emits `pane.updated` and nothing else; the rolled-up
    // `status` that `childIsRunning` reads lives on the TAB row, which no push
    // carries on that edge. So the corpus froze `status` at fetch time on a
    // socket that never dropped — finished agents spinning forever.
    expect(agentLabel()).toBe('2 agents');

    WS_TABS = FINISHED();
    await refreshTabs(WS); // the 5s poll, or the status-edge refetch

    expect(corpusRows().map((t) => t.status)).toEqual(['idle', 'idle']);
    expect(agentLabel()).toBe(null);
    // …and the rail says the same thing, from the same bytes.
    expect(cachedTabsFor(WS).map((t) => t.status)).toEqual(corpusRows().map((t) => t.status));
  });

  it('does not repaint the corpus when a poll lands the same list', async () => {
    // The dedupe is load-bearing. Without it the 5s poll republishes the group
    // every 5s whether or not anything moved, and every corpus reader —
    // `ChatPane`, a transcript — repaints on that interval. That is the
    // poll-on-everything this module exists to avoid.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const seen: WorkspaceTabs[][] = [];
    const off = subscribeAllTabs((g) => seen.push(g));
    await refreshTabs(WS);
    await refreshTabs(WS);
    off();
    expect(seen).toEqual([]);
  });

  it('ignores the clock fill that moves on every single read', async () => {
    // MEASURED ON THE LIVE COCKPIT, and the reason the dedupe above needed a
    // signature rather than a raw compare: `clock.fill` is derived from
    // wall-clock time SERVER-SIDE, so it is a different float on every read.
    // 31 of 72 rows differed by it alone, 6 seconds apart, with nothing
    // happening. A raw `JSON.stringify` compare therefore never holds on a real
    // workspace, and the 5s poll would repaint every corpus reader — `ChatPane`,
    // a transcript — forever. That is the poll-on-everything through the back
    // door, which this module exists to avoid.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const seen: WorkspaceTabs[][] = [];
    const off = subscribeAllTabs((g) => seen.push(g));
    // The real delta, taken from the live diff: ~1.8e-5 over six seconds.
    WS_TABS = [
      tab('t1', { clock: { ...CLOCK, fill: CLOCK.fill + 0.0000178 } }),
      tab('t2', { clock: { ...CLOCK, fill: CLOCK.fill + 0.0000178 } }),
    ] as Tab[];
    await refreshTabs(WS);
    off();
    expect(seen).toEqual([]);
  });

  it('still repaints when the fill crosses a rung the chip actually draws', async () => {
    // The other side of it — the dedupe must not swallow a real change. The
    // chip quantises with `Math.floor(fill * CHAT_DECAY_DAYS)` (ChatChip), so
    // the signature uses that same function: the corpus repaints exactly when
    // the ring would move, and never for a change too small to draw.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const seen: WorkspaceTabs[][] = [];
    const off = subscribeAllTabs((g) => seen.push(g));
    // 0.1 → 0.6 crosses floor(f*4) from 0 to 2: a visible rung change.
    WS_TABS = [
      tab('t1', { clock: { ...CLOCK, fill: 0.6 } }),
      tab('t2', { clock: { ...CLOCK, fill: 0.6 } }),
    ] as Tab[];
    await refreshTabs(WS);
    off();
    expect(seen).toHaveLength(1);
  });

  it('leaves a workspace the sidebar has not loaded to the corpus itself', async () => {
    // The merge is not a back door into groups the sidebar knows nothing about.
    await refreshTabs('w_unknown');
    expect(cachedAllTabs()?.map((g) => g.id)).toEqual([WS, OTHER]);
  });
});

describe('a status edge in a workspace the sidebar never loaded', () => {
  /** The `pane.updated` the server sends on a status flip, and nothing else. */
  const paneEdge = (tabId: string, status: string) =>
    ({
      type: 'pane.updated',
      tab_id: tabId,
      pane: { id: `p-${tabId}`, status, agents: 0 },
    }) as unknown as MuxpadEvent;

  const emit = (e: MuxpadEvent) => {
    for (const h of [...handlers]) h(e);
  };
  /** Past the 250ms coalescing window, on real timers. */
  const settleEdge = () => new Promise((r) => setTimeout(r, 320));

  it('refreshes the corpus, which is the only cache holding that row', async () => {
    // `t3` lives in a workspace the rail has not expanded, so no `tabs.ts` slot
    // holds it and nothing above would refetch. The flat 'recent' list renders
    // it anyway, and a directed card can point straight at it.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const off = subscribeAllTabs(() => {});
    CORPUS = [
      { id: WS, slug: 'muxpad', name: 'muxpad', tabs: BUSY() },
      {
        id: OTHER,
        slug: 'other',
        name: 'Other',
        tabs: [tab('t3', { status: 'idle', done: true })],
      },
    ];

    emit(paneEdge('t3', 'idle'));
    await settleEdge();
    off();

    expect(listAllTabs).toHaveBeenCalledTimes(1);
    expect(cachedAllTabs()?.find((g) => g.id === OTHER)?.tabs[0]?.status).toBe('idle');
  });

  it('stays silent when nothing is rendering from the corpus', async () => {
    // No mounted reader means no pixels to correct, and the mount-time
    // `loadAllTabs` will fetch anyway. This guard is what keeps an idle page
    // from turning every status edge in the cockpit into a request.
    emit(paneEdge('t3', 'blocked'));
    await settleEdge();
    expect(listAllTabs).not.toHaveBeenCalled();
  });

  it('cannot be driven into a request storm by a stream of edges', async () => {
    // The 250ms window coalesces a BURST, but says nothing about a sustained
    // stream: a busy workspace the sidebar has not loaded can produce genuine
    // status edges several times a second, and each window would then spend a
    // full `/api/tabs/all` (~40 KB measured). Four a second is not a poll — it
    // is worse than one. So the edge path also has a floor between fetches.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const off = subscribeAllTabs(() => {});
    // Two bursts, each past the 250ms coalescing window but inside the floor.
    emit(paneEdge('t3', 'idle'));
    await settleEdge();
    emit(paneEdge('t3', 'working'));
    await settleEdge();
    off();
    // The second burst is held, not dropped — it lands on the floor's timer.
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a row the sidebar already covers', async () => {
    // `t1` is in a loaded workspace, so the refetch queued by `tabs.ts` feeds
    // the corpus through `mergeWorkspaceTabs`. A second request here would buy
    // an answer already on its way.
    const { subscribeAllTabs } = await import('./lib/all-tabs');
    const off = subscribeAllTabs(() => {});
    emit(paneEdge('t1', 'idle'));
    await settleEdge();
    off();
    expect(listAllTabs).not.toHaveBeenCalled();
    // …and the sidebar's own refetch is what ran instead.
    expect(listTabs).toHaveBeenCalled();
  });
});

describe('a push for a row the corpus does not hold', () => {
  it('stops calling the corpus fresh, so the next read actually asks', async () => {
    // A workspace created after the corpus was fetched: the `tab.added` cannot
    // be spliced in (an id is not a group), and under FRESH_MS the next
    // `loadAllTabs` would answer from the cache that provably lacks it.
    for (const h of [...handlers]) {
      h({ type: 'tab.added', workspace_id: 'w_new', tab: tab('t9') } as MuxpadEvent);
    }
    await loadAllTabs();
    expect(listAllTabs).toHaveBeenCalledTimes(1);
  });
});
