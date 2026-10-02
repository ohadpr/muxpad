import { describe, expect, it } from 'vitest';
import { type SortableTab, compareUnpinnedTabs, sortSidebarTabs } from './tab-order.js';

describe('wire-only sidebar order', () => {
  it.each([null, 200])(
    'uses ID order for every permutation and conflicting position map (activity %s)',
    (last_activity_at) => {
      const rows = [
        { id: 'c', last_activity_at },
        { id: 'b', last_activity_at },
        { id: 'a', last_activity_at },
      ];
      const permutations = <T>(xs: T[]): T[][] =>
        xs.length === 0
          ? [[]]
          : xs.flatMap((x, i) =>
              permutations(xs.filter((_, j) => j !== i)).map((tail) => [x, ...tail]),
            );
      for (const serverInput of permutations(rows)) {
        const manual = new Map(serverInput.map((t, i) => [t.id, i]));
        const server = [...serverInput].sort((a, b) => compareUnpinnedTabs(a, b, manual));
        expect(server.map((t) => t.id)).toEqual(['a', 'b', 'c']);
        for (const clientInput of permutations(rows)) {
          const published = new Map(clientInput.map((t, i) => [t.id, i]));
          expect(sortSidebarTabs(clientInput, published).map((t) => t.id)).toEqual(['a', 'b', 'c']);
          expect(sortSidebarTabs(clientInput, published)).toEqual(server);
        }
      }
    },
  );

  it('keeps pinned manual order separate from canonical unpinned ties', () => {
    const rows = [{ id: 'z', pinned: true }, { id: 'a', pinned: true }, { id: 'd' }, { id: 'c' }];
    expect(sortSidebarTabs(rows).map((t) => t.id)).toEqual(['z', 'a', 'c', 'd']);
  });
});

// These were written against `compareByUserTouch`, the global list's own
// comparator, back when the per-workspace order still ranked on machine
// activity. That function is gone (it had no production caller and had become
// byte-for-byte identical to this one — see tab-order.ts), but the contracts
// it was pinning are real and now belong to the single surviving comparator.
describe('compareUnpinnedTabs ranks on what YOU did', () => {
  const sort = (rows: SortableTab[]) => [...rows].sort(compareUnpinnedTabs).map((r) => r.id);
  const T = 1_800_000_000_000;

  it('ignores pty churn: a WORKING chat does not outrank one you just messaged', () => {
    // The measured defect, in one assertion. On the live cockpit 6 of 58 chats
    // were `working` and held 6 of the global top 7 — all under a minute old,
    // none of them the user's doing. `noisy` is that chat: its
    // `last_activity_at` is seconds old because a log is scrolling in it, and
    // its `last_user_at` is a week old because nobody has said anything to it.
    const noisy: SortableTab = {
      id: 'noisy',
      status: 'working',
      last_activity_at: T,
      last_user_at: T - 7 * 86_400_000,
    };
    const mine: SortableTab = {
      id: 'mine',
      status: 'idle',
      last_activity_at: T - 3_600_000,
      last_user_at: T - 3_600_000,
    };
    expect(sort([noisy, mine])).toEqual(['mine', 'noisy']);
    // This assertion used to be its own opposite: the per-workspace order was
    // expected to put `noisy` FIRST, on the reasoning that inside a workspace
    // you have already chosen the context so machine activity is signal. A
    // screenshot killed that — see `compareUnpinnedTabs`. Both surfaces now
    // rank on the user's touch, and the duplicate comparator that encoded the
    // old split is deleted rather than left to drift.
    expect(sort([mine, noisy])).toEqual(['mine', 'noisy']);
  });

  it('still puts a chat that WANTS YOU first — the rail’s one loud bit survives', () => {
    const blocked: SortableTab = { id: 'blocked', status: 'blocked', last_user_at: T - 86_400_000 };
    const recent: SortableTab = { id: 'recent', status: 'idle', last_user_at: T };
    expect(sort([recent, blocked])).toEqual(['blocked', 'recent']);
  });

  it('falls back to last_activity_at for a row an OLDER server sent', () => {
    // Wire compat, and the only way `last_user_at` is ever absent: a server
    // that predates the column. Degrading to today's ordering beats degrading
    // to none.
    const legacy: SortableTab = { id: 'legacy', last_activity_at: T };
    const current: SortableTab = { id: 'current', last_activity_at: 0, last_user_at: T - 1 };
    expect(sort([current, legacy])).toEqual(['legacy', 'current']);
  });

  it('sinks a row with no timestamp at all, and breaks ties by id', () => {
    const rows: SortableTab[] = [
      { id: 'nothing' },
      { id: 'b', last_user_at: T },
      { id: 'a', last_user_at: T },
    ];
    expect(sort(rows)).toEqual(['a', 'b', 'nothing']);
  });

  it('is a consistent total order even when every row is null', () => {
    // (-Inf) - (-Inf) is NaN, which makes a comparator inconsistent and its
    // sort implementation-defined.
    const rows: SortableTab[] = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    expect(sort(rows)).toEqual(['a', 'b', 'c']);
  });
});
