import { describe, expect, it } from 'vitest';
import {
  SWIPE_FLICK,
  SWIPE_LATCH,
  SWIPE_SLOP,
  SWIPE_TRAY_WIDTH,
  clampOffset,
  decideAxis,
  settleOpen,
} from './swipe-axis';

describe('decideAxis — the axis lock', () => {
  it('stays undecided inside the slop, so a tap never slides', () => {
    expect(decideAxis(0, 0)).toBe('undecided');
    expect(decideAxis(-5, 2)).toBe('undecided');
    expect(decideAxis(0, SWIPE_SLOP - 1)).toBe('undecided');
  });

  it('claims horizontal for a decisive LEFT drag', () => {
    expect(decideAxis(-30, 4)).toBe('horizontal');
  });

  it('gives a decisive vertical drag to the scroller', () => {
    expect(decideAxis(-4, 40)).toBe('vertical');
    expect(decideAxis(0, -40)).toBe('vertical');
  });

  it('resolves a 45° drag to VERTICAL — a list is a scroller first', () => {
    // The asymmetry is deliberate: failing to scroll is infuriating and
    // constant; failing to open a tray costs one more, more deliberate swipe.
    expect(decideAxis(-30, 30)).toBe('vertical');
    expect(decideAxis(-30, 25)).toBe('vertical');
  });

  it('a rightward drag from CLOSED is vertical — there is nothing to reveal', () => {
    expect(decideAxis(40, 3)).toBe('vertical');
  });

  it('a rightward drag from OPEN is horizontal — that is how you close it', () => {
    expect(decideAxis(40, 3, 'undecided', true)).toBe('horizontal');
  });

  it('is LOCKED once decided — the whole point', () => {
    // A gesture that began as a scroll can never become a swipe halfway down,
    // and vice versa. A per-frame "whichever delta is bigger now" test
    // thrashes between the two on any diagonal drag; this cannot.
    expect(decideAxis(-500, 0, 'vertical')).toBe('vertical');
    expect(decideAxis(0, 500, 'horizontal')).toBe('horizontal');
  });
});

describe('clampOffset', () => {
  it('tracks the finger inside the tray', () => {
    expect(clampOffset(0, -40)).toBe(-40);
  });

  it('never rubber-bands past the tray — there is nothing further to reveal', () => {
    expect(clampOffset(0, -400)).toBe(-SWIPE_TRAY_WIDTH);
  });

  it('never goes positive — the row would tear off the left edge', () => {
    expect(clampOffset(0, 80)).toBe(0);
  });

  it('drives CLOSING from an open base with the same arithmetic', () => {
    expect(clampOffset(-SWIPE_TRAY_WIDTH, 60)).toBe(-SWIPE_TRAY_WIDTH + 60);
    expect(clampOffset(-SWIPE_TRAY_WIDTH, 400)).toBe(0);
  });
});

describe('settleOpen — there is no half-open resting state', () => {
  it('a left FLICK opens even from barely-moved', () => {
    expect(settleOpen(-SWIPE_FLICK, -SWIPE_FLICK)).toBe(true);
  });

  it('a right FLICK closes even from fully open', () => {
    expect(settleOpen(-SWIPE_TRAY_WIDTH, SWIPE_FLICK)).toBe(false);
  });

  it('below flick speed, POSITION decides', () => {
    const past = -(SWIPE_TRAY_WIDTH * SWIPE_LATCH + 1);
    const short = -(SWIPE_TRAY_WIDTH * SWIPE_LATCH - 1);
    // dx inside the flick threshold, so only the offset matters.
    expect(settleOpen(past, -10)).toBe(true);
    expect(settleOpen(short, -10)).toBe(false);
  });

  it('the latch threshold is not dead code', () => {
    // Regression: an earlier version used SWIPE_SLOP as the flick threshold.
    // Since the axis lock already requires clearing the slop, EVERY horizontal
    // gesture then counted as a flick and the position branch never ran.
    expect(SWIPE_FLICK).toBeGreaterThan(SWIPE_SLOP);
    const short = -(SWIPE_TRAY_WIDTH * SWIPE_LATCH - 1);
    expect(settleOpen(short, -(SWIPE_SLOP + 1))).toBe(false);
  });

  it('a committed flick does not need a full traverse', () => {
    expect(SWIPE_LATCH).toBeLessThan(0.5);
  });
});

describe('the tray geometry meets the touch-target floor', () => {
  it('each action is comfortably past 44px wide', () => {
    expect(SWIPE_TRAY_WIDTH / 2).toBeGreaterThanOrEqual(44);
  });
});
