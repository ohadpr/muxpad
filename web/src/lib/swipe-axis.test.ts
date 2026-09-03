import { describe, expect, it } from 'vitest';
import {
  SWIPE_ACTION_COUNT,
  SWIPE_ACTION_WIDTH,
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

describe('the tray geometry — three actions, one derivation', () => {
  it('reveals exactly the three actions the tray renders', () => {
    // Pin, Mark unread, Close. If a fourth is ever added this fails first,
    // which is the point: the width below has to be re-argued, not just
    // inherited.
    expect(SWIPE_ACTION_COUNT).toBe(3);
  });

  it('opens FAR ENOUGH to show every action, not two of three', () => {
    // The regression this guards is the one the third action actually hit: the
    // tray width was a literal `* 2`, so the row slid two-thirds of the way and
    // the last action stayed permanently off-screen with its tap target clipped
    // to nothing. Stated as "a fully-open row exposes N whole actions" rather
    // than by restating the definition, which would pass however wrong the
    // count was.
    expect(Math.abs(clampOffset(0, -1000)) / SWIPE_ACTION_WIDTH).toBe(SWIPE_ACTION_COUNT);
  });

  it('every action clears the 44px touch floor', () => {
    // Both axes: the width here, and the row's own 44px min-height in
    // NavTree.css (the actions are `align-items: stretch`, so they are exactly
    // as tall as the row).
    expect(SWIPE_TRAY_WIDTH / SWIPE_ACTION_COUNT).toBeGreaterThanOrEqual(44);
  });

  it('keeps the tray under HALF the row on a 375px phone', () => {
    // 375 (iPhone SE 3 / 13 mini) is the floor the width is DERIVED from, less
    // the sheet scroller's 8px inset each side — not 390, which is only the
    // size this was designed against. The face is what you tap to dismiss the
    // tray, so it has to stay unmistakably the biggest thing on the row.
    // This is the assertion that pins SWIPE_ACTION_WIDTH: a fourth action, or
    // widening these back toward 76, fails here first.
    const rowWidth = 375 - 8 * 2;
    const face = rowWidth - SWIPE_TRAY_WIDTH;
    expect(face).toBeGreaterThanOrEqual(rowWidth / 2);
  });

  it('still leaves a real target at 360, where the half is knowingly missed', () => {
    // Narrow Android. Documented as an accepted exception rather than shaved
    // for — so it gets the weaker bound it actually holds, and a regression
    // that blew past it would still be caught.
    const rowWidth = 360 - 8 * 2;
    const face = rowWidth - SWIPE_TRAY_WIDTH;
    expect(face).toBeGreaterThan(SWIPE_ACTION_WIDTH * 2);
    expect(face / rowWidth).toBeGreaterThan(0.45);
  });

  it('revealing ONE action is not yet a commitment to open', () => {
    // The latch is a fraction of the tray, so it scales with the count for
    // free — and that rescaling is load-bearing, not incidental. At two 76px
    // actions, dragging a single action's width (76) already cleared the latch
    // (60.8) and the row snapped open. At three it does not: one action is a
    // peek, and you have to mean it. A fixed-pixel latch would have lost this.
    expect(settleOpen(-SWIPE_ACTION_WIDTH, -1)).toBe(false);
    expect(settleOpen(-SWIPE_TRAY_WIDTH, -1)).toBe(true);
    expect(SWIPE_ACTION_WIDTH).toBeLessThan(SWIPE_TRAY_WIDTH * SWIPE_LATCH);
  });
});
