import { describe, expect, it } from 'vitest';
import {
  AUTO_PAGE_EVENTS,
  canAutoPageHistory,
  historyCap,
  showLoadEarlier,
} from './history-budget';

/**
 * HOW MUCH HISTORY A CHAT DRAGS IN BY ITSELF.
 *
 * Measured before this existed, on the real muxpad chat: 941 rows and 114,977px
 * on open, growing to 1,775 rows and 202,971px during twelve seconds of
 * scrolling, because the only limit on the scroll-up pager was reaching the
 * start of the transcript. A 12,000px gesture moved the reader 4,965px — the
 * document was growing faster than they could scroll.
 */
describe('the automatic history budget', () => {
  it('lets a fresh chat page freely', () => {
    // A server tail is ~126 rows, so the first several scroll-backs must be
    // invisible. A budget you notice immediately is a wall.
    // (Counted in EVENTS, which over-counts against rows — see the module doc.)
    expect(canAutoPageHistory({ loaded: 126, grants: 0 })).toBe(true);
    expect(canAutoPageHistory({ loaded: AUTO_PAGE_EVENTS - 1, grants: 0 })).toBe(true);
  });

  it('stops at the budget', () => {
    expect(canAutoPageHistory({ loaded: AUTO_PAGE_EVENTS, grants: 0 })).toBe(false);
    // …and well past it, which is the state that was measured.
    expect(canAutoPageHistory({ loaded: 1775, grants: 0 })).toBe(false);
  });

  it('grants a whole budget per ask, not one page', () => {
    // A reader who has said "further back" once is digging. Six clicks to cross
    // what the scroll used to cross by itself is the friction being avoided.
    expect(historyCap(0)).toBe(AUTO_PAGE_EVENTS);
    expect(historyCap(1)).toBe(AUTO_PAGE_EVENTS * 2);
    expect(canAutoPageHistory({ loaded: AUTO_PAGE_EVENTS + 10, grants: 1 })).toBe(true);
  });

  it('treats a negative grant count as none', () => {
    expect(historyCap(-5)).toBe(AUTO_PAGE_EVENTS);
  });

  it('offers the button only when the BUDGET is what is stopping it', () => {
    // At the start of the transcript there is nothing to load, and a button
    // that does nothing is worse than no button.
    expect(showLoadEarlier({ loaded: 5000, grants: 0, hasMoreOlder: false })).toBe(false);
    expect(showLoadEarlier({ loaded: 5000, grants: 0, hasMoreOlder: true })).toBe(true);
  });

  it('…and never while the scroll can still do it', () => {
    // Under budget the scroll already works; a button there would be a second
    // way to do the thing that is already happening.
    expect(showLoadEarlier({ loaded: 100, grants: 0, hasMoreOlder: true })).toBe(false);
  });

  it('hides again once a grant re-opens the budget', () => {
    const at = { loaded: AUTO_PAGE_EVENTS + 10, hasMoreOlder: true };
    expect(showLoadEarlier({ ...at, grants: 0 })).toBe(true);
    expect(showLoadEarlier({ ...at, grants: 1 })).toBe(false);
  });
});
