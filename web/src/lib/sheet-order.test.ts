import { describe, expect, it } from 'vitest';
import { advanceSheetOrder } from './sheet-order';

/**
 * The sheet's list order is frozen while the sheet is open.
 *
 * With the rail's tints, bars and word chips deleted, ORDER is most of what
 * the list still says — and the order is server-computed and re-derived by a
 * 5s poll. These tests pin the two halves of the rule: nothing already on
 * screen may move, and nothing may be hidden by the freeze.
 */

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = <T extends { id: string }>(list: T[]) => list.map((t) => t.id);

describe('the first step captures whatever the server offered', () => {
  it('renders the server order verbatim and remembers it', () => {
    const step = advanceSheetOrder(null, tabs('a', 'b', 'c'));
    expect(ids(step.order)).toEqual(['a', 'b', 'c']);
    expect(step.snapshot).toEqual(['a', 'b', 'c']);
  });

  it('an empty list is a valid capture, not "not captured yet"', () => {
    // Otherwise a workspace with no chats would re-capture on every poll and
    // the freeze would never arm.
    expect(advanceSheetOrder(null, []).snapshot).toEqual([]);
  });
});

describe('a re-sort under the user is ignored', () => {
  it('holds the captured order however the server re-orders', () => {
    const first = advanceSheetOrder(null, tabs('a', 'b', 'c', 'd'));
    // The poll comes back with `d` promoted to the top (it just went blocked)
    // and `a` demoted. On screen, nothing moves.
    const next = advanceSheetOrder(first.snapshot, tabs('d', 'c', 'b', 'a'));
    expect(ids(next.order)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is stable across any number of polls, not just the first', () => {
    let snap = advanceSheetOrder(null, tabs('a', 'b', 'c')).snapshot;
    for (const shuffled of [tabs('c', 'a', 'b'), tabs('b', 'c', 'a'), tabs('c', 'b', 'a')]) {
      const step = advanceSheetOrder(snap, shuffled);
      expect(ids(step.order)).toEqual(['a', 'b', 'c']);
      snap = step.snapshot;
    }
  });
});

describe('rows may still arrive and leave — they just may not reshuffle', () => {
  it('a NEW tab is appended, so nothing on screen shifts to make room', () => {
    const first = advanceSheetOrder(null, tabs('a', 'b'));
    // The server sorts the new chat to the top (it is the most recent).
    const next = advanceSheetOrder(first.snapshot, tabs('new', 'a', 'b'));
    expect(ids(next.order)).toEqual(['a', 'b', 'new']);
  });

  it('several new tabs keep the server’s order AMONG THEMSELVES', () => {
    const first = advanceSheetOrder(null, tabs('a'));
    const next = advanceSheetOrder(first.snapshot, tabs('y', 'a', 'x'));
    expect(ids(next.order)).toEqual(['a', 'y', 'x']);
  });

  it('an appended tab then STAYS where it landed', () => {
    const first = advanceSheetOrder(null, tabs('a', 'b'));
    const second = advanceSheetOrder(first.snapshot, tabs('new', 'a', 'b'));
    const third = advanceSheetOrder(second.snapshot, tabs('new', 'b', 'a'));
    expect(ids(third.order)).toEqual(['a', 'b', 'new']);
  });

  it('a closed tab drops out without disturbing the rest', () => {
    const first = advanceSheetOrder(null, tabs('a', 'b', 'c'));
    const next = advanceSheetOrder(first.snapshot, tabs('c', 'a'));
    expect(ids(next.order)).toEqual(['a', 'c']);
    // …and it is forgotten, so a tab with the same id later reads as new.
    expect(next.snapshot).toEqual(['a', 'c']);
  });

  it('never invents, duplicates or drops a row the server sent', () => {
    const first = advanceSheetOrder(null, tabs('a', 'b', 'c'));
    const live = tabs('d', 'c', 'a', 'e');
    const next = advanceSheetOrder(first.snapshot, live);
    expect([...ids(next.order)].sort()).toEqual([...ids(live)].sort());
    expect(new Set(ids(next.order)).size).toBe(next.order.length);
  });
});

describe('the freeze is ORDER only', () => {
  it('hands back the SERVER’s object for every row, so live status flows through', () => {
    // The rows carry status/unread; the freeze must never hold a stale copy of
    // one. Identity is the cheapest way to assert that.
    const a1 = { id: 'a', status: 'idle' };
    const first = advanceSheetOrder(null, [a1, { id: 'b', status: 'idle' }]);
    const a2 = { id: 'a', status: 'blocked' };
    const next = advanceSheetOrder(first.snapshot, [{ id: 'b', status: 'idle' }, a2]);
    expect(next.order[0]).toBe(a2);
    expect(next.order[0]?.status).toBe('blocked');
  });
});
