import { describe, expect, it } from 'vitest';
import {
  type FreezableTab,
  type TabFreeze,
  activeTabFreezeIndex,
  advanceTabFreeze,
  freezeActiveTab,
} from './tab-freeze';

const tabs = (spec: string): FreezableTab[] =>
  spec
    .split(' ')
    .filter(Boolean)
    .map((s) => (s.startsWith('*') ? { id: s.slice(1), pinned: true } : { id: s }));

const ids = (list: FreezableTab[]): string => list.map((t) => t.id).join(' ');

describe('freezeActiveTab', () => {
  it('renders the active tab where it was, however the rest re-sort', () => {
    // Frozen at index 2. The server has since moved it to the top (its own
    // activity bumped it) and shuffled the others; it must not budge.
    expect(ids(freezeActiveTab(tabs('b a c d'), 'b', 2))).toBe('a c b d');
  });

  it('leaves everything alone when there is no active tab or no capture', () => {
    expect(ids(freezeActiveTab(tabs('a b c'), null, 1))).toBe('a b c');
    expect(ids(freezeActiveTab(tabs('a b c'), 'b', null))).toBe('a b c');
  });

  it('is a no-op when the active tab is already at its frozen index', () => {
    const list = tabs('a b c');
    expect(freezeActiveTab(list, 'b', 1)).toBe(list); // same reference: no re-render churn
  });

  it('ignores an active tab from another workspace', () => {
    expect(ids(freezeActiveTab(tabs('a b c'), 'zzz', 0))).toBe('a b c');
  });

  it('never freezes a PINNED active tab — manual order owns those', () => {
    // Pinned tabs are dragged into place; re-inserting one by a captured
    // index would fight the user's own ordering.
    expect(ids(freezeActiveTab(tabs('*a *b c'), 'b', 0))).toBe('a b c');
  });

  it('clamps below the pinned divider when the pinned block grew', () => {
    // Captured at 0 back when nothing was pinned; two tabs have been pinned
    // since. Honouring 0 literally would render an unpinned tab above the
    // divider, in the manual block.
    expect(ids(freezeActiveTab(tabs('*x *y a b'), 'b', 0))).toBe('x y b a');
  });

  it('clamps to the end when the list shrank under a stale index', () => {
    expect(ids(freezeActiveTab(tabs('a b'), 'a', 9))).toBe('b a');
  });
});

describe('activeTabFreezeIndex', () => {
  it('captures the on-screen index of the active tab', () => {
    expect(activeTabFreezeIndex(tabs('a b c'), 'c')).toBe(2);
  });

  it('returns null for no active tab, an unknown tab, or a pinned one', () => {
    expect(activeTabFreezeIndex(tabs('a b'), null)).toBeNull();
    expect(activeTabFreezeIndex(tabs('a b'), 'zzz')).toBeNull();
    expect(activeTabFreezeIndex(tabs('*a b'), 'a')).toBeNull();
  });
});

describe('advanceTabFreeze — the sidebar over time', () => {
  /**
   * Drive the state machine exactly as the hook does: each step's output
   * order becomes the next step's "displayed", and the very first step
   * measures against its own input (the hook seeds that ref with `tabs`).
   */
  const run = (steps: { tabs: string; activeId: string | null }[]) => {
    let freeze: TabFreeze | null = null;
    let displayed: FreezableTab[] | null = null;
    const out: string[] = [];
    for (const s of steps) {
      const list = tabs(s.tabs);
      const r: { freeze: TabFreeze | null; order: FreezableTab[] } = advanceTabFreeze(freeze, {
        tabs: list,
        displayed: displayed ?? list,
        activeId: s.activeId,
      });
      freeze = r.freeze;
      displayed = r.order;
      out.push(ids(r.order));
    }
    return { out, freeze };
  };

  // ── THE FREEZE IS DIRECTIONAL ───────────────────────────────────────────
  // It used to hold the active row at the index it was clicked at, for the
  // whole visit, in both directions. The half that was right: a row must not
  // slide DOWN the list while you work in it — other chats get busier, push it
  // away, and closing the row below it or re-finding where you are becomes a
  // moving-target problem.
  //
  // The half that was wrong: opening a chat makes it the most recent thing you
  // have touched, so the server sorts it to the top — and the freeze held it
  // at row 8, where it had been two hours cold. The promotion the click earned
  // never reached the screen, and the row that DID climb was the one you had
  // just left, its freeze having been dropped on the way out. Reported as "when
  // I touch a chat it doesn't go to the top".
  //
  // So: up is allowed and kept, down is refused.
  it('lets the active row CLIMB to its sorted place, and keeps it there', () => {
    const { out } = run([
      { tabs: 'a b c d', activeId: 'c' }, // arrive at c (index 2)
      { tabs: 'c a b d', activeId: 'c' }, // its own arrival bumped it to the top
      { tabs: 'c d a b', activeId: 'c' }, // d goes busy and climbs
    ]);
    expect(out[0]).toBe('a b c d');
    // THE PROMOTION LANDS. This was 'a b c d' before — the click's whole
    // visible consequence, suppressed.
    expect(out[1]).toBe('c a b d');
    // …and d climbing cannot push c back down. c stays at 0; d takes the next
    // free row rather than c's.
    expect(out[2]).toBe('c d a b');
  });

  it('refuses to be pushed DOWN by another chat getting busier', () => {
    const { out } = run([
      { tabs: 'c a b', activeId: 'c' }, // arrive at c, already top
      { tabs: 'a c b', activeId: 'c' }, // a goes busy and outranks it
      { tabs: 'a b c', activeId: 'c' }, // and then b does too
    ]);
    expect(out[0]).toBe('c a b');
    expect(out[1]).toBe('c a b'); // held
    expect(out[2]).toBe('c a b'); // still held — this is the moving target
  });

  it('settles into its sorted position the moment it is deactivated', () => {
    const { out, freeze } = run([
      { tabs: 'a b c', activeId: 'c' },
      { tabs: 'a b c', activeId: 'c' }, // nothing promoted it; still at the end
      { tabs: 'c a b', activeId: null }, // navigated away → falls into place
    ]);
    expect(out[1]).toBe('a b c');
    expect(out[2]).toBe('c a b');
    expect(freeze).toBeNull();
  });

  it('a newly activated tab is captured where the user just clicked it', () => {
    // The capture still measures against the DISPLAYED order, so selecting a
    // row never yanks it out from under the cursor on the same frame. What
    // changed is only what happens AFTER: the server's promotion is now let
    // through, instead of this index being a ceiling for the whole visit.
    const { out } = run([
      { tabs: 'a b c', activeId: 'b' }, // b frozen at 1
      { tabs: 'b a c', activeId: 'b' }, // server bumps b — and it now lands
      { tabs: 'b a c', activeId: 'a' }, // click a, displayed at index 1
    ]);
    expect(out[1]).toBe('b a c');
    expect(out[2]).toBe('b a c'); // a captured where it was shown, not moved
  });

  it('retries the capture until the tab list has actually loaded', () => {
    const { out, freeze } = run([
      { tabs: '', activeId: 'c' }, // URL knows the tab; the fetch hasn't landed
      { tabs: 'a b c', activeId: 'c' }, // now capture — where it first renders
      { tabs: 'a b c', activeId: 'c' }, // nothing promotes it; it holds at 2
    ]);
    expect(out[1]).toBe('a b c');
    expect(out[2]).toBe('a b c');
    expect(freeze).toEqual({ id: 'c', index: 2 });
  });

  it('a cold chat opened from the bottom ends up at the top — the whole report', () => {
    // The sequence as lived: a chat two hours cold at row 3, clicked. The
    // server stamps it on the /seen that arrival fires, the next list has it
    // first, and the row is there to see rather than waiting for you to leave.
    const { out, freeze } = run([
      { tabs: 'a b c d', activeId: 'd' }, // click the coldest row
      { tabs: 'd a b c', activeId: 'd' }, // the view stamp lands
      { tabs: 'd a b c', activeId: 'd' }, // and it stays put while you read
    ]);
    expect(out[0]).toBe('a b c d');
    expect(out[1]).toBe('d a b c');
    expect(out[2]).toBe('d a b c');
    expect(freeze).toEqual({ id: 'd', index: 0 });
  });

  it('drops the freeze when the active tab gets pinned, and re-captures after unpin', () => {
    const { out } = run([
      { tabs: 'a b c', activeId: 'c' }, // frozen at 2
      { tabs: '*c a b', activeId: 'c' }, // dragged → pinned; manual order wins
      { tabs: 'c a b', activeId: 'c' }, // unpinned again: re-capture at 0…
      { tabs: 'a b c', activeId: 'c' }, // …and hold there
    ]);
    expect(out[1]).toBe('c a b');
    expect(out[2]).toBe('c a b');
    expect(out[3]).toBe('c a b');
  });

  it('is idempotent for the same inputs (StrictMode double-invoke is safe)', () => {
    const first = advanceTabFreeze(null, {
      tabs: tabs('a b c'),
      displayed: tabs('a b c'),
      activeId: 'b',
    });
    const second = advanceTabFreeze(first.freeze, {
      tabs: tabs('a b c'),
      displayed: first.order,
      activeId: 'b',
    });
    expect(second.freeze).toEqual(first.freeze);
    expect(ids(second.order)).toBe(ids(first.order));
  });
});
