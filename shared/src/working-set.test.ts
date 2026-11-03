import { describe, expect, it } from 'vitest';
import {
  WORKING_SET_DECAY_MS,
  WORKING_SET_SIZE,
  type WorkingSlot,
  isStale,
  parseWorkingSet,
  removeFromWorkingSet,
  touchWorkingSet,
} from './working-set.js';

const T0 = 1_700_000_000_000;
const min = (n: number) => n * 60_000;
const ids = (s: readonly WorkingSlot[]) => s.map((x) => x.tabId);

describe('the stability promise', () => {
  it('using a chat already in the strip moves NOTHING', () => {
    // The whole design. An MRU strip reorders as a result of your own click:
    // you open slot 3, it becomes slot 1, the chat you came from becomes slot
    // 2, and everything you knew about where things are is wrong.
    let s: WorkingSlot[] = [];
    for (const id of ['a', 'b', 'c', 'd']) s = touchWorkingSet(s, id, T0);
    const before = ids(s);
    s = touchWorkingSet(s, 'c', T0 + min(1));
    expect(ids(s)).toEqual(before);
    s = touchWorkingSet(s, 'a', T0 + min(2));
    expect(ids(s)).toEqual(before);
  });

  it('…but the slot’s own timestamp does move, or nothing could ever decay', () => {
    let s = touchWorkingSet([], 'a', T0);
    s = touchWorkingSet(s, 'a', T0 + min(30));
    expect(s[0]?.at).toBe(T0 + min(30));
  });

  it('a new chat APPENDS — first free slot, never an insert', () => {
    let s = touchWorkingSet([], 'a', T0);
    s = touchWorkingSet(s, 'b', T0 + min(1));
    expect(ids(s)).toEqual(['a', 'b']);
  });
});

describe('eviction', () => {
  const fill = () => {
    let s: WorkingSlot[] = [];
    for (let i = 0; i < WORKING_SET_SIZE; i++) s = touchWorkingSet(s, `t${i}`, T0 + min(i));
    return s;
  };

  it('replaces the LEAST RECENTLY USED, in place', () => {
    // In place, so the five survivors keep their positions and their numbers.
    // `t0` is oldest; the newcomer takes exactly its slot.
    const s = touchWorkingSet(fill(), 'new', T0 + min(100));
    expect(ids(s)[0]).toBe('new');
    expect(ids(s).slice(1)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('…and recency decides ONLY that — never the visible order', () => {
    // t0 is the oldest by position but we just used it, so t1 is the LRU.
    let s = fill();
    s = touchWorkingSet(s, 't0', T0 + min(50));
    s = touchWorkingSet(s, 'new', T0 + min(51));
    expect(ids(s)).toEqual(['t0', 'new', 't2', 't3', 't4', 't5']);
  });

  it('never grows past the cap', () => {
    let s = fill();
    for (let i = 0; i < 20; i++) s = touchWorkingSet(s, `x${i}`, T0 + min(100 + i));
    expect(s).toHaveLength(WORKING_SET_SIZE);
  });
});

describe('decay', () => {
  it('marks a slot nobody has touched inside the window as STALE', () => {
    // Stale, not gone: it keeps its place and its number, and it is simply
    // the first slot a new chat is allowed to take.
    const cold = { tabId: 'cold', at: T0 };
    const warm = { tabId: 'warm', at: T0 + min(1) };
    const later = T0 + WORKING_SET_DECAY_MS + min(0.5);
    expect(isStale(cold, later)).toBe(true);
    expect(isStale(warm, later)).toBe(false);
  });

  it('is evaluated on READ, not by a sweep', () => {
    // There must be no timer. A sweep that fires while you are looking at the
    // strip changes it under the pointer — and now that staleness only picks
    // a victim, there is nothing for a sweep to do in the first place.
    const cold = { tabId: 'cold', at: T0 };
    expect(isStale(cold, T0 + WORKING_SET_DECAY_MS - 1)).toBe(false);
    expect(isStale(cold, T0 + WORKING_SET_DECAY_MS + 1)).toBe(true);
  });

  /**
   * THE BREAK THE SIMULATION DID NOT WEIGH: a night.
   *
   * Every other return is a few hours and the metric treated them all alike.
   * A night is the return where the strip is worth the most — the morning is
   * spent picking up what you put down — and it is the one 8h could not
   * survive: stop at 18:00 and the strip is empty by 02:00, with no bedtime
   * late enough and no morning early enough to save it. Reported exactly that
   * way: "overnight I go to sleep and wake up and some of them are out".
   *
   * Pinned as a PROPERTY rather than as the number, so the constant can be
   * tuned and this stays the floor it cannot be tuned under.
   */
  it('survives a night — stop after work, return the next morning', () => {
    const hours = (n: number) => n * 60 * 60 * 1000;
    const lastMessage = Date.UTC(2026, 0, 5, 16, 0); // a 16:00 finish, early
    const nextMorning = Date.UTC(2026, 0, 6, 8, 0); // …and an 08:00 return
    const slot = { tabId: 'yesterday', at: lastMessage };
    expect(isStale(slot, nextMorning)).toBe(false);
    // …and it still lets go of the day before that, which is the half of
    // decay that keeps the strip from becoming the 85-row list again.
    expect(isStale(slot, lastMessage + hours(25))).toBe(true);
  });

  it('a decayed slot is SPENT FIRST, and in place', () => {
    // It used to be removed, and the array closed up — so every slot after it
    // moved. As tabs that is the one unforgivable move, and it was reported
    // as exactly that. Decay now decides who gets REPLACED, not who is shown.
    let s: WorkingSlot[] = [];
    for (let i = 0; i < WORKING_SET_SIZE; i++) s = touchWorkingSet(s, `t${i}`, T0 + i);
    // t0 is the oldest, so it is the stale one spent — and nothing else moves.
    s = touchWorkingSet(s, 'fresh', T0 + WORKING_SET_DECAY_MS + min(1));
    expect(s).toHaveLength(WORKING_SET_SIZE);
    expect(ids(s)[0]).toBe('fresh');
    expect(ids(s).slice(1)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('prefers a stale slot over evicting a live one', () => {
    // What decay is FOR, kept: the strip you come back to still loses its
    // stale slots, it just loses them to something rather than to a clock.
    let s: WorkingSlot[] = [];
    s = touchWorkingSet(s, 'old', T0);
    for (let i = 1; i < WORKING_SET_SIZE; i++) {
      s = touchWorkingSet(s, `t${i}`, T0 + WORKING_SET_DECAY_MS + min(i));
    }
    const later = T0 + WORKING_SET_DECAY_MS + min(30);
    s = touchWorkingSet(s, 'fresh', later);
    // 'old' is the only stale one, so it goes — not t1, which is the LRU of
    // the live ones.
    expect(ids(s)).not.toContain('old');
    expect(ids(s)).toContain('t1');
    expect(ids(s)[0]).toBe('fresh');
  });

  it('never moves a slot that is not the one being replaced', () => {
    // The whole promise, stated as a property rather than an example.
    let s: WorkingSlot[] = [];
    for (let i = 0; i < WORKING_SET_SIZE; i++) s = touchWorkingSet(s, `t${i}`, T0 + i);
    const before = ids(s);
    for (const [tab, when] of [
      ['t3', T0 + min(1)],
      ['t0', T0 + min(2)],
      ['t5', T0 + WORKING_SET_DECAY_MS + min(5)],
    ] as const) {
      s = touchWorkingSet(s, tab, when);
      expect(ids(s), `touching ${tab} moved something`).toEqual(before);
    }
  });
});

describe('“not now”', () => {
  it('frees the slot and closes the gap', () => {
    let s: WorkingSlot[] = [];
    for (const id of ['a', 'b', 'c']) s = touchWorkingSet(s, id, T0);
    expect(ids(removeFromWorkingSet(s, 'b'))).toEqual(['a', 'c']);
  });

  it('removing something that is not there is not an error', () => {
    expect(removeFromWorkingSet([{ tabId: 'a', at: T0 }], 'zzz')).toHaveLength(1);
  });
});

describe('parsing whatever is in storage', () => {
  it('reads a good value', () => {
    expect(parseWorkingSet(JSON.stringify([{ tabId: 'a', at: T0 }]))).toEqual([
      { tabId: 'a', at: T0 },
    ]);
  });

  it('answers EMPTY for anything it cannot read', () => {
    // A working set is a convenience and may never be the reason a rail fails
    // to render.
    for (const bad of [null, undefined, '', 'not json', '{}', '[1,2,3]', '[{"tabId":5}]'])
      expect(parseWorkingSet(bad as string)).toEqual([]);
  });

  it('clamps a stored list that is too long', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ tabId: `t${i}`, at: T0 }));
    expect(parseWorkingSet(JSON.stringify(big))).toHaveLength(WORKING_SET_SIZE);
  });
});
