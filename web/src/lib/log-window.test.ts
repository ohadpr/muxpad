import { describe, expect, it } from 'vitest';
import { canFlushTail, windowStart } from './log-window';

/**
 * THE RULE THAT WAS WRITTEN THREE TIMES AND WAS WRONG AT AN EDGE EACH TIME.
 *
 * Spawn cards at the tail, spawn cards at the head, browser moments at the
 * head — three reports, one shape. These hold the shape itself so the next
 * thing that draws into the log inherits it.
 */
describe('windowStart', () => {
  const m = (at: number) => ({ at });

  it('skips everything below the window', () => {
    expect(windowStart([m(1), m(2), m(500), m(900)], 500)).toBe(2);
  });

  it('skips nothing when there is no history left to load', () => {
    // A null floor means the window starts at the beginning of the conversation,
    // so nothing can be below it — and hiding those would make them unreachable.
    expect(windowStart([m(1), m(2)], null)).toBe(0);
  });

  it('skips everything when the whole set predates the window', () => {
    expect(windowStart([m(1), m(2)], 1000)).toBe(2);
  });

  it('is inclusive of the floor itself', () => {
    // A moment stamped exactly at the oldest loaded message IS in the window.
    expect(windowStart([m(500)], 500)).toBe(0);
  });

  it('handles an empty set', () => {
    expect(windowStart([], 500)).toBe(0);
  });
});

describe('canFlushTail', () => {
  it('is false before the log has any timeline', () => {
    // The bottom is not "the present" yet, it is the nearest edge — and it is
    // the one the reader is looking at.
    expect(canFlushTail([])).toBe(false);
    expect(canFlushTail([{ at: null }, { at: null }])).toBe(false);
  });

  it('is true as soon as one entry is dated', () => {
    expect(canFlushTail([{ at: null }, { at: 5 }])).toBe(true);
  });
});
