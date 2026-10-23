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
  // TWO REPORTS, OPPOSITE DIRECTIONS, ONE ANSWER — see the header.
  //
  //   1. "when I touch a chat it doesn't go to the top"
  //   2. "I click a chat … and then it immediately jumps up … causing me to
  //      not be able to remember the order of chats"
  //
  // Both true, about different moments: (1) the list you come back to, (2) the
  // list you are looking at. So the row holds still while you are in it, in
  // BOTH directions, and settles the moment you leave.
  it('does not let the active row climb while you are in it', () => {
    const { out } = run([
      { tabs: 'a b c d', activeId: 'c' }, // arrive at c (index 2)
      { tabs: 'c a b d', activeId: 'c' }, // you send a message; recency bumps it
      { tabs: 'c d a b', activeId: 'c' }, // d goes busy and climbs
    ]);
    expect(out[0]).toBe('a b c d');
    // HELD. The promotion is real and is not thrown away — it is waiting in
    // the server's order, and lands the instant you navigate away.
    expect(out[1]).toBe('a b c d');
    // …and the rest of the list keeps re-sorting around it: d has climbed
    // above a and b, which it is welcome to do.
    expect(out[2]).toBe('d a c b');
  });

  it('…and the promotion lands the moment you leave', () => {
    const { out } = run([
      { tabs: 'a b c d', activeId: 'c' },
      { tabs: 'c a b d', activeId: 'c' }, // held while you work
      { tabs: 'c a b d', activeId: null }, // away → it is where recency put it
    ]);
    expect(out[1]).toBe('a b c d');
    expect(out[2]).toBe('c a b d');
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
    // The capture measures against the DISPLAYED order, so selecting a row
    // never yanks it out from under the cursor — on this frame or any later
    // one in the visit.
    const { out } = run([
      { tabs: 'a b c', activeId: 'b' }, // b frozen at 1
      { tabs: 'b a c', activeId: 'b' }, // server bumps b — held at 1
      { tabs: 'b a c', activeId: 'a' }, // click a — captured where it was SHOWN
    ]);
    expect(out[1]).toBe('a b c');
    // a was on row 0 when you clicked it, so a is on row 0 after you click it.
    // b's promotion is released by its own deactivation and takes the next
    // free row; the list finishes settling when you leave a.
    expect(out[2]).toBe('a b c');
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

  it('a cold chat opened from the bottom stays put, then takes the top on exit', () => {
    // The sequence as lived, both ways round: a chat two hours cold at row 3,
    // clicked. It reads where you clicked it for as long as you are there —
    // and the next time you come looking, it is at the top.
    const { out, freeze } = run([
      { tabs: 'a b c d', activeId: 'd' }, // click the coldest row
      { tabs: 'd a b c', activeId: 'd' }, // recency promotes it; held
      { tabs: 'd a b c', activeId: null }, // leave → it lands
    ]);
    expect(out[0]).toBe('a b c d');
    expect(out[1]).toBe('a b c d');
    expect(out[2]).toBe('d a b c');
    expect(freeze).toBeNull();
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
