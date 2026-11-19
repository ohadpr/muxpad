import { describe, expect, it } from 'vitest';
import { type SortableTab, sortSidebarTabs, userTouchAt } from './tab-order.js';

/**
 * THE ORDER HOLDS STILL. These were tests of a comparator: the unpinned block
 * ranked blocked-first then most-recently-touched, with null and NaN guards
 * and an id tiebreak. There is no comparator any more — the order is the one
 * the caller was already holding — so what is asserted is the two things that
 * replaced all of it: nothing reorders, and the pinned divider still has two
 * contiguous blocks to sit between.
 *
 * The recency key survives as `userTouchAt`, which is a measurement rather
 * than an order; its one reader is the ⌘K recents list.
 */
describe('sortSidebarTabs', () => {
  it('keeps the order it was given', () => {
    const rows = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    expect(sortSidebarTabs(rows).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not reorder on status, attention, recency or activity', () => {
    // Every key the old comparator read, all pointing the other way at once:
    // `quiet` is blocked AND the most recently touched AND the most recently
    // active, and it still does not move. A row that jumps when its agent
    // changes state is a row you cannot point at.
    const T = 1_800_000_000_000;
    const rows = [
      { id: 'first', last_user_at: T - 7 * 86_400_000, last_activity_at: 0 },
      {
        id: 'quiet',
        status: 'blocked',
        attention: true,
        last_user_at: T,
        last_activity_at: T,
      } as SortableTab & { status: string; attention: boolean },
    ];
    expect(sortSidebarTabs(rows).map((t) => t.id)).toEqual(['first', 'quiet']);
  });

  it('puts the pinned block first, each half in its own given order', () => {
    // The ONE rearrangement left, and it is not a sort: the sidebar draws its
    // divider at `tabs.filter(t => t.pinned).length`, so a pinned row left in
    // the middle would put the divider in the wrong place.
    const rows = [{ id: 'd' }, { id: 'z', pinned: true }, { id: 'c' }, { id: 'a', pinned: true }];
    expect(sortSidebarTabs(rows).map((t) => t.id)).toEqual(['z', 'a', 'd', 'c']);
  });

  it('is idempotent — applying it to its own answer changes nothing', () => {
    // Both sides run it: the server publishes the order and the client
    // re-applies it around a spliced row. A second pass that moved anything
    // would make the two disagree about a list neither had changed.
    const rows = [{ id: 'd' }, { id: 'z', pinned: true }, { id: 'c' }];
    const once = sortSidebarTabs(rows);
    expect(sortSidebarTabs(once)).toEqual(once);
  });

  it('appends: a new row goes where the caller put it', () => {
    // How a new chat reaches the list — `insertTabRow` concatenates and calls
    // this. Nothing here may promote it.
    const held = [{ id: 'old' }, { id: 'older' }];
    expect(sortSidebarTabs([...held, { id: 'new' }]).map((t) => t.id)).toEqual([
      'old',
      'older',
      'new',
    ]);
  });

  it('does not mutate its input', () => {
    const rows = [{ id: 'd' }, { id: 'z', pinned: true }];
    sortSidebarTabs(rows);
    expect(rows.map((t) => t.id)).toEqual(['d', 'z']);
  });
});

describe('userTouchAt — the measurement the recents list reads', () => {
  const T = 1_800_000_000_000;

  it('is what YOU did, not what the machine did', () => {
    // The measured defect it exists for: on the live cockpit 6 of 58 chats
    // were `working` and held 6 of the global top 7 — all under a minute old,
    // none of them the user's doing. `last_activity_at` is bumped by pty
    // output every five seconds; this column is not.
    expect(userTouchAt({ id: 'noisy', last_activity_at: T, last_user_at: T - 86_400_000 })).toBe(
      T - 86_400_000,
    );
  });

  it('falls back to activity for a row an OLDER server sent', () => {
    // Wire compat, and the only way `last_user_at` is ever absent: a server
    // that predates the column. Degrading to the noisier reading beats none.
    expect(userTouchAt({ id: 'legacy', last_activity_at: T })).toBe(T);
  });

  it('has no answer when neither stamp is there', () => {
    expect(userTouchAt({ id: 'bare' })).toBeNull();
  });
});
