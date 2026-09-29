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

  function mountBar(kids: readonly Kid[]) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const agents = kids.map((k) => ({
      id: `chat:${k.tabId}`,
      label: k.tabName,
      steps: 0,
      busy: true,
      chat: { workspaceSlug: 'personal', tabSlug: k.tabId },
    }));
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={liveStatusLabel({ agentCount: agents.length })}
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
    expect(liveStatusLabel({ agentCount: running().length })).toBe(
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
    expect(liveStatusLabel({ agentCount: runningChildren(quiet).length })).toBe(null);
  });
});

describe('the pane wires the roster to that predicate', () => {
  const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

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
