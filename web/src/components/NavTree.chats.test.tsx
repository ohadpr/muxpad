import { CHAT_DECAY_DAYS, type Tab, chatClock } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { groupChats } from './NavTree';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/**
 * A tab, as the server would publish it: the clock derived by the server's own
 * deriver, `done` set the way the server sets it.
 */
function tab(id: string, opts: Partial<Tab> & { agedDays?: number } = {}): Tab {
  const { agedDays = 0, ...rest } = opts;
  const pinned = rest.pinned === true;
  return {
    id,
    name: id,
    slug: id,
    created_at: NOW,
    updated_at: NOW,
    layout: { type: 'pane', id: `${id}-p` },
    clock: chatClock({ started_at: NOW - agedDays * DAY, now: NOW, pinned }),
    done: !pinned && agedDays >= CHAT_DECAY_DAYS,
    ...rest,
  } as Tab;
}

/** Just the ids, in render order — what the rail actually shows. */
const shape = (groups: { chat: Tab; children: Tab[] }[]) =>
  groups.map((g) => [g.chat.id, g.children.map((c) => c.id)] as const);

describe('groupChats', () => {
  it('nests a spawned chat under its parent and never also at top level', () => {
    const { live } = groupChats([tab('a'), tab('kid', { spawned_by: 'a' }), tab('b')], NOW);
    expect(shape(live)).toEqual([
      ['a', ['kid']],
      ['b', []],
    ]);
  });

  it('keeps the server’s order for both parents and children', () => {
    const { live } = groupChats(
      [tab('a'), tab('k2', { spawned_by: 'a' }), tab('k1', { spawned_by: 'a' })],
      NOW,
    );
    expect(shape(live)).toEqual([['a', ['k2', 'k1']]]);
  });

  // A chat must never be invisible because of a pointer. The parent may live in
  // another workspace, or have been closed — either way the chat itself is
  // still a chat, and it gets a top-level row rather than disappearing.
  it('promotes a chat whose parent is not in this list, rather than dropping it', () => {
    const { live } = groupChats([tab('a'), tab('orphan', { spawned_by: 'gone' })], NOW);
    expect(shape(live)).toEqual([
      ['a', []],
      ['orphan', []],
    ]);
  });

  it('survives a chat that claims to be its own parent', () => {
    const { live } = groupChats([tab('loop', { spawned_by: 'loop' })], NOW);
    expect(shape(live)).toEqual([['loop', []]]);
  });

  it('moves a decayed chat into the done group', () => {
    const { live, done } = groupChats([tab('fresh'), tab('old', { agedDays: 9 })], NOW);
    expect(shape(live)).toEqual([['fresh', []]]);
    expect(shape(done)).toEqual([['old', []]]);
  });

  // The whole reason a child shares its parent's clock: work spawned under a
  // chat should not outlive it — and, just as load-bearing, should not predecease
  // it either. A child's OWN lifecycle is never consulted, in either direction.
  it('takes a fresh child into done WITH its parent', () => {
    const { live, done } = groupChats(
      [tab('old', { agedDays: 9 }), tab('kid', { spawned_by: 'old', agedDays: 0 })],
      NOW,
    );
    expect(live).toEqual([]);
    expect(shape(done)).toEqual([['old', ['kid']]]);
  });

  it('keeps a child that calls ITSELF done under its live parent', () => {
    // The server resolves a child's clock to its parent's, so this row should
    // not exist — but if one ever does (a stale row mid-poll, a hand-built
    // one), the child must not quietly vanish from under a live parent.
    const { live, done } = groupChats(
      [tab('alive'), tab('kid', { spawned_by: 'alive', agedDays: 9 })],
      NOW,
    );
    expect(shape(live)).toEqual([['alive', ['kid']]]);
    expect(done).toEqual([]);
  });

  it('never lets a pinned chat decay, however old', () => {
    const { live, done } = groupChats([tab('pin', { agedDays: 99, pinned: true })], NOW);
    expect(shape(live)).toEqual([['pin', []]]);
    expect(done).toEqual([]);
  });

  // The pin divider is drawn at this index. Counted over the LIVE tops only,
  // or a decayed pinned row would leave the hairline stranded one row low.
  it('counts the pin seam over the live top-level rows only', () => {
    const { livePinned } = groupChats(
      [
        tab('p1', { pinned: true }),
        tab('p2', { pinned: true }),
        tab('kid', { spawned_by: 'p1' }),
        tab('u1'),
        tab('gone', { agedDays: 9 }),
      ],
      NOW,
    );
    expect(livePinned).toBe(2);
  });

  it('is empty-safe', () => {
    expect(groupChats([], NOW)).toEqual({ live: [], done: [], livePinned: 0 });
  });
});
