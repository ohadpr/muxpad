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

  it('holds the active row still while the others re-sort around it', () => {
    const { out } = run([
      { tabs: 'a b c d', activeId: 'c' }, // arrive at c (index 2)
      { tabs: 'c a b d', activeId: 'c' }, // c bumped to top by its own activity
      { tabs: 'c d a b', activeId: 'c' }, // d goes busy and climbs
    ]);
    expect(out[0]).toBe('a b c d');
    expect(out[1]).toBe('a b c d'); // c held; nothing else moved either
    expect(out[2]).toBe('d a c b'); // d climbed, c still third
  });

  it('settles into its sorted position the moment it is deactivated', () => {
    const { out, freeze } = run([
      { tabs: 'a b c', activeId: 'c' },
      { tabs: 'c a b', activeId: 'c' }, // still frozen at the bottom
      { tabs: 'c a b', activeId: null }, // navigated away → falls into place
    ]);
    expect(out[1]).toBe('a b c');
    expect(out[2]).toBe('c a b');
    expect(freeze).toBeNull();
  });

  it('a newly activated tab is captured where the user just clicked it', () => {
    // While b was active and frozen at index 1, the server moved b to the top
    // — so `a` is displayed FIRST but sits SECOND in server order. Clicking a
    // must leave it under the cursor; capturing from server order instead
    // would have dropped it a row the instant it was selected.
    const { out } = run([
      { tabs: 'a b c', activeId: 'b' }, // b frozen at 1
      { tabs: 'b a c', activeId: 'b' }, // server bumped b; displayed stays a b c
      { tabs: 'b a c', activeId: 'a' }, // click a, displayed at index 0
    ]);
    expect(out[1]).toBe('a b c');
    expect(out[2]).toBe('a b c'); // a held at 0; b settles into 1, not 0
  });

  it('retries the capture until the tab list has actually loaded', () => {
    const { out, freeze } = run([
      { tabs: '', activeId: 'c' }, // URL knows the tab; the fetch hasn't landed
      { tabs: 'a b c', activeId: 'c' }, // now capture — where it first renders
      { tabs: 'c a b', activeId: 'c' },
    ]);
    expect(out[1]).toBe('a b c');
    expect(out[2]).toBe('a b c');
    expect(freeze).toEqual({ id: 'c', index: 2 });
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
