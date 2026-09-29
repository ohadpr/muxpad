import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaneStatus } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { liveStatusLabel, runningChildren } from '../lib/live-status';
import { SessionBar } from './ChatPane';
import { StateChip } from './StateChip';

/**
 * ONE LIVE SET, THREE SURFACES.
 *
 * "Bottom row says 1 agents but the two sub chats in the sidebar don't show
 *  spinners so idk what's up."
 *
 * Measured against the database at the time, the three surfaces gave three
 * different answers about the same four children of `muxpad`:
 *
 *   child           retired_at   the bar   sidebar spinner   pane status
 *   status-line     NULL         busy      spinner           working
 *   artifact-urls   NULL         busy      none              idle
 *   xws-build       NULL         busy      none              DEAD
 *   new-chat-fix    NULL         busy      none              idle
 *
 * The bar said 4. One was running.
 *
 * ── WHY THE BAR WAS WRONG, AND THE SIDEBAR RIGHT ───────────────────────────
 * The roster counted every child with `retired_at IS NULL`, and retirement is a
 * LIFECYCLE fact — "has this chat left the live list" — not a liveness one. A
 * worker that finished its turn and is waiting for you is unretired. A worker
 * whose runner DIED is unretired. Neither is running, and `xws-build` was
 * literally dead while the bar counted it as an agent at work.
 *
 * The sidebar asks the only question that means "is this working": the pane's
 * `status`, which for a runner-owned pane is the runner's own registry. So the
 * sidebar is the source, and the other two now read it.
 *
 * ── WHY ONE TEST AND NOT THREE ─────────────────────────────────────────────
 * Three tests, one per surface, is how three surfaces drift apart in the first
 * place: each passes against its own idea of the answer. This test derives the
 * truth ONCE — by rendering the real `StateChip` and seeing which rows it spins
 * for — and then holds the count, the roster and the predicate to it. Change
 * StateChip's rule and this fails until the bar follows.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A child as these three surfaces see it: a name, a live status, a lifecycle bit. */
type Kid = { tabId: string; tabName: string; status?: PaneStatus; done: boolean };

/** The real scene, one row per state a child is actually found in. */
const CHILDREN: readonly Kid[] = [
  { tabId: 'status-line', tabName: 'status-line', status: 'working', done: false },
  { tabId: 'artifact-urls', tabName: 'artifact-urls', status: 'idle', done: false },
  { tabId: 'xws-build', tabName: 'xws-build', status: 'dead', done: false },
  { tabId: 'new-chat-fix', tabName: 'new-chat-fix', status: 'idle', done: false },
  // …plus the states the scene did not happen to contain, so the agreement is
  // pinned across the whole vocabulary rather than across one afternoon's data.
  { tabId: 'asked-you', tabName: 'asked-you', status: 'blocked', done: false },
  { tabId: 'finished', tabName: 'finished', status: 'ready', done: false },
  { tabId: 'retired-but-busy', tabName: 'retired-but-busy', status: 'working', done: true },
  { tabId: 'long-gone', tabName: 'long-gone', status: 'idle', done: true },
  // A row from a server too old to report one. No evidence of running is not
  // evidence of running — see childIsRunning.
  { tabId: 'no-status', tabName: 'no-status', done: false },
];

/**
 * THE TRUTH, taken from the sidebar itself rather than restated.
 *
 * Renders the real `StateChip` for each child and asks whether it drew the
 * spinner. Nothing here hard-codes "working" — if StateChip is ever taught to
 * spin for `blocked` too, this set grows and every assertion below moves with
 * it, which is the entire point of deriving it.
 */
function sidebarSpins(): string[] {
  const out: string[] = [];
  for (const kid of CHILDREN) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<StateChip status={kid.status} />);
    });
    if (host.querySelector('.navtree-state-spin')) out.push(kid.tabName);
    act(() => root.unmount());
    host.remove();
  }
  return out;
}

describe('the bar, the roster and the sidebar name the same running children', () => {
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  /** What the bar and the roster are built from — the one predicate. */
  const running = () => runningChildren(CHILDREN);

  /**
   * The roster EXACTLY as ChatPane builds it: child chats carry `chat` (there
   * is somewhere to navigate to), harness subagents do not. That one field is
   * the discriminator the component splits on, so the test splits on it too.
   */
  function rosterFor(kids: readonly Kid[], subagents = 0) {
    return [
      ...kids.map((k) => ({
        id: `chat:${k.tabId}`,
        label: k.tabName,
        steps: 0,
        busy: true,
        chat: { workspaceSlug: 'personal', tabSlug: k.tabId },
      })),
      // No `chat` — a Task fan-out inside one turn. Not a pane, no row anywhere,
      // cannot be visited. It is the population that used to be added into the
      // same number as the chats.
      ...Array.from({ length: subagents }, (_, i) => ({
        id: `sub-${i}`,
        label: `explore-${i}`,
        steps: 3,
        busy: true,
      })),
    ];
  }

  /** ChatPane's own derivation, so the label under test is the shipped one. */
  const labelFor = (agents: ReturnType<typeof rosterFor>) => {
    const chats = agents.filter((a) => 'chat' in a && a.chat).length;
    return liveStatusLabel({ chats, subagents: agents.length - chats });
  };

  function mountBar(kids: readonly Kid[], subagents = 0) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const agents = rosterFor(kids, subagents);
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={labelFor(agents)}
          agents={agents}
          mode="chat"
        />,
      );
    });
    return host;
  }

  it('agrees on WHICH children are running', () => {
    // The one assertion this file exists for. Both sides are computed, neither
    // is a literal — so this cannot be satisfied by updating a hard-coded list.
    expect(running().map((k) => k.tabName)).toEqual(sidebarSpins());
  });

  it('and on HOW MANY — the number above the composer', () => {
    const truth = sidebarSpins();
    expect(liveStatusLabel({ chats: running().length })).toBe(
      `${truth.length} agent${truth.length === 1 ? '' : 's'}`,
    );
  });

  it('and the roster lists exactly those, openable', () => {
    const truth = sidebarSpins();
    const box = mountBar(running());
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-live')?.click());
    const names = [...box.querySelectorAll('.chat-roster-name')].map((n) => n.textContent);
    expect(names).toEqual(truth);
  });

  /**
   * The specific regressions, named — so a failure says which child and why
   * rather than just "sets differ".
   */
  it('does not count a child whose runner DIED', () => {
    // `xws-build`, status `dead`: the runner gave up. It was being counted as an
    // agent at work, which is the most wrong the indicator can be.
    expect(running().map((k) => k.tabName)).not.toContain('xws-build');
  });

  it('does not count a child that is merely UNRETIRED', () => {
    // `artifact-urls` and `new-chat-fix`: finished their turn, never retired.
    // `retired_at IS NULL` means the chat still exists, not that it is working.
    expect(running().map((k) => k.tabName)).not.toContain('artifact-urls');
    expect(running().map((k) => k.tabName)).not.toContain('new-chat-fix');
  });

  it('DOES count a retired child that is working again', () => {
    // The inverse, and the reason the predicate reads status rather than
    // negating `done`: a sub-chat retires at a turn end by design, so a worker
    // you are still using carries `retired_at` between its turns. Right now
    // outranks the row — the same rule spawnState states for the cards.
    expect(running().map((k) => k.tabName)).toContain('retired-but-busy');
  });

  it('counts nothing for a child whose status we were never told', () => {
    // No evidence of running is not evidence of running. The opposite default
    // is what produced four phantom agents.
    expect(running().map((k) => k.tabName)).not.toContain('no-status');
  });

  it('shows no live cell at all when nothing is running', () => {
    // The end state of the bug report: the four children of the scene, none of
    // them working, and the strip silent rather than claiming four. Built by
    // demoting every `working` row, so it cannot rot when a row is added above.
    const quiet = CHILDREN.map((k) => ({ ...k, status: 'idle' as const }));
    expect(runningChildren(quiet)).toEqual([]);
    expect(liveStatusLabel({ chats: runningChildren(quiet).length })).toBe(null);
  });
});

/**
 * THE COUNT EQUALS THE ROWS — the live instance that reopened this.
 *
 * "The status cell read '5 agents'. The sidebar showed 2 rows. The sidebar was
 *  RIGHT: of the five workers I spawned, three had already finished."
 *
 * Verified against the server at the time: exactly two children were `working`.
 * The user's question was "do the 5 agents count some additional primitive that
 * doesn't show up in the sidebar?" — and it does: the roster is a UNION of child
 * chats and harness subagents, and the cell was sized with `roster.length`.
 *
 * That the question had to be ASKED is the failure, so these pin the number to
 * the rows rather than to a literal — and do it through the RENDERED roster, so
 * the number and the list it opens cannot drift apart.
 */
describe('the number above the composer equals the child rows, whatever else runs', () => {
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  function mount(agents: ReturnType<typeof buildRoster>) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const chats = agents.filter((a) => 'chat' in a && a.chat).length;
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={liveStatusLabel({ chats, subagents: agents.length - chats })}
          agents={agents}
          mode="chat"
        />,
      );
    });
    return host;
  }

  function buildRoster(kids: readonly Kid[], subagents: number) {
    return [
      ...kids.map((k) => ({
        id: `chat:${k.tabId}`,
        label: k.tabName,
        steps: 0,
        busy: true,
        chat: { workspaceSlug: 'personal', tabSlug: k.tabId },
      })),
      ...Array.from({ length: subagents }, (_, i) => ({
        id: `sub-${i}`,
        label: `explore-${i}`,
        steps: 3,
        busy: true,
      })),
    ];
  }

  /** The leading number the cell renders. */
  const leadingCount = (box: HTMLElement) =>
    Number(
      box
        .querySelector('.chat-status-seg.-live .chat-status-seg-label')
        ?.textContent?.match(/^(\d+)/)?.[1] ?? -1,
    );

  it('reads the sidebar count, not the roster length, with subagents present', () => {
    // THE OBSERVED SCENE, reconstructed: the running children of the real set,
    // plus three harness subagents. `5 agents` is what shipped.
    const truth = sidebarSpins();
    const box = mount(buildRoster(runningChildren(CHILDREN), 3));
    expect(leadingCount(box)).toBe(truth.length);
    expect(
      box.querySelector('.chat-status-seg.-live .chat-status-seg-label')?.textContent,
    ).not.toBe(`${truth.length + 3} agents`);
  });

  it('names the subagents instead of folding them in', () => {
    const box = mount(buildRoster(runningChildren(CHILDREN), 3));
    // The second population is reported — it is real work — but as ITSELF.
    expect(
      box.querySelector('.chat-status-seg.-live .chat-status-seg-label')?.textContent,
    ).toContain('3 subagents');
  });

  it('matches the number of NAVIGABLE rows the roster opens', () => {
    // The tightest form of "one source": the number and the list it opens are
    // rendered from the same array, so a child row and a subagent row cannot be
    // counted alike. Only child chats render a link — a subagent has nowhere to
    // go — which is the same `chat` field the count splits on.
    const box = mount(buildRoster(runningChildren(CHILDREN), 4));
    act(() => box.querySelector<HTMLButtonElement>('.chat-status-seg.-live')?.click());
    expect(box.querySelectorAll('.chat-roster-link')).toHaveLength(leadingCount(box));
    // …and the roster still lists everything that is running, both kinds.
    expect(box.querySelectorAll('.chat-roster-item')).toHaveLength(
      runningChildren(CHILDREN).length + 4,
    );
  });

  it('says nothing about agents when only subagents are running', () => {
    // No children at all: the cell must not borrow the word that means "a chat
    // you can open", because there is no row anywhere to reconcile it against.
    const box = mount(buildRoster([], 2));
    expect(box.querySelector('.chat-status-seg.-live .chat-status-seg-label')?.textContent).toBe(
      '2 subagents',
    );
  });
});

describe('the pane wires the roster to that predicate', () => {
  const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

  it('sizes the cell from the child chats, not the whole roster', () => {
    // `agentCount: rosterAgents.length` is the exact expression that put two
    // populations behind one number. The pure functions above are only the
    // truth if the component splits them the same way.
    expect(SRC).not.toContain('agentCount: rosterAgents.length');
    expect(SRC).toContain('rosterAgents.filter((a) => a.chat).length');
    expect(SRC).toContain('subagents: rosterAgents.length - rosterChats');
  });

  it('derives the live children with runningChildren, not by negating done', () => {
    // The pure functions above are only the truth if the component calls them.
    // `!c.chat.done` is the exact expression that produced the bug; it must not
    // come back as the live filter.
    expect(SRC).toContain('runningChildren(');
    expect(SRC).not.toContain('spawnedCards.filter((c) => !c.chat.done)');
  });

  it('does not re-assert busy on a list already filtered to the busy ones', () => {
    // `busy: true` was hard-coded onto every child in the roster loop — which is
    // how a dead worker got a spinning row. It is now true by construction, and
    // a second literal would be a second answer to the same question.
    const loop = SRC.slice(SRC.indexOf('for (const kid of spawnedLive)'));
    expect(loop.slice(0, 400)).not.toContain('busy: true');
  });
});
