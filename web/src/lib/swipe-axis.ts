/**
 * Swipe-to-reveal, as pure arithmetic.
 *
 * The whole difficulty of a swipeable row inside a scrolling list is ONE
 * decision: is this drag a horizontal reveal or a vertical scroll? Get it
 * wrong and the list either refuses to scroll (because every touch is claimed
 * as a swipe) or the tray never opens (because the scroller ate the touch and
 * sent `pointercancel`). So the decision is made ONCE per gesture, on the
 * first movement that clears the slop, and then LOCKED — a gesture that
 * started as a scroll can never become a swipe halfway down, and vice versa.
 * A per-frame "whichever delta is bigger right now" test, which is the
 * tempting version, thrashes between the two on any diagonal drag.
 *
 * It lives here, free of React and of the DOM, because it is the part that is
 * genuinely easy to get wrong and impossible to eyeball in a browser: the
 * ratio, the slop and the latch threshold all interact.
 */

/** Which way this gesture went. `undecided` until it clears the slop. */
export type SwipeAxis = 'undecided' | 'horizontal' | 'vertical';

/**
 * How far a finger must travel before the axis is decided at all. Below this
 * the touch is still a candidate TAP, and claiming it either way would make
 * taps feel like they slide. 8px is the usual list-view slop — under a
 * fingertip's own wobble on a stationary press.
 */
export const SWIPE_SLOP = 8;

/**
 * How decisively horizontal a drag must be to claim the gesture. Above 1, so a
 * 45° drag resolves to VERTICAL: a list is a scroller first, and the cost of
 * the two errors is not symmetric. Failing to scroll is infuriating and
 * happens constantly; failing to open a tray costs one more, more deliberate,
 * swipe.
 */
export const SWIPE_RATIO = 1.4;

/**
 * How many actions the tray reveals: Pin, Mark unread, Close.
 *
 * A COUNT, not a hardcoded tray width, because the tray geometry is
 * `count × width` in three places at once (how far the row slides, where the
 * release latches, what the CSS lays out) and the moment a third action was
 * added, a literal `* 2` left the row sliding two-thirds of the way and the
 * last action permanently off-screen.
 */
export const SWIPE_ACTION_COUNT = 3;

/**
 * Width of ONE revealed action button.
 *
 * 59, down from the 76 that two actions could afford — DERIVED, not picked.
 *
 * THE RULE: the tray may never take more than HALF the row. The half is about
 * the FACE, not about reading the name — the row slides off the tray, so its
 * name is off the left edge either way while the tray is open (it already was,
 * at two actions). What the face has to stay is a TARGET: tapping it is how you
 * dismiss the tray, and it is the escape hatch for a row you opened by
 * accident, so it must remain unmistakably the biggest thing on the row rather
 * than a stripe beside a wall of buttons.
 *
 * THE WIDTH IT YIELDS. The sheet's rows are the viewport less 8px of scroller
 * inset each side. Applying the rule at the narrowest CURRENT iPhone, 375
 * (SE 3 / 13 mini — not 390, which is merely the size this was designed
 * against): row 359, half 179.5, over three actions 59.8 → 59. At 390 that
 * leaves the face 213 of 374 (57%). Three 76s would have taken 228px — 61% of
 * the row at 390, and MORE than the whole face at 375.
 *
 * The rule is not universal and the exception is deliberate: at 360 (common
 * narrow Android) the row is 344 and the face 167 — 48.5%, a hair under. Held
 * rather than shaved further because 167px is still nearly four touch targets
 * wide and plainly the largest region on the row, while a fourth 2px would
 * start crowding the labels for a width almost nothing in the fleet has.
 *
 * 59 is still 15px past the 44px touch floor on the short axis, and the longest
 * label ("Unread") measures 45px in the 12.5px/600 type the actions use
 * (measured in the browser, not estimated), so nothing truncates or wraps.
 *
 * SwipeRow.tsx publishes this to CSS as `--swipe-action-width`, which
 * `.swiperow-action` in SwipeRow.css consumes — the stylesheet must never
 * hardcode the number, because the tray geometry below is derived from it and
 * a drifting literal would leave the tray not lining up with the row.
 */
export const SWIPE_ACTION_WIDTH = 59;

/** Total tray width — how far the row slides when fully open. DERIVED: the
 *  count and the width are the only two numbers, and everything else (the
 *  clamp, the latch, the CSS layout) falls out of their product. */
export const SWIPE_TRAY_WIDTH = SWIPE_ACTION_WIDTH * SWIPE_ACTION_COUNT;

/**
 * Fraction of the tray you must drag past for a release to LATCH open.
 * Below half, so a committed flick doesn't need to be a full traverse.
 */
export const SWIPE_LATCH = 0.4;

/**
 * Travel that makes a gesture DIRECTIONAL rather than positional — a flick.
 * Deliberately well above SWIPE_SLOP: if it were the slop, every gesture that
 * cleared the axis test would also count as a flick and the latch below would
 * be dead code.
 */
export const SWIPE_FLICK = 24;

/**
 * Decide (once) which axis a gesture belongs to.
 *
 * `current` is the axis decided so far; anything other than `undecided` is
 * returned unchanged — that is the lock. Deltas are measured from the gesture
 * ORIGIN, not the previous frame, so a slow drift can't accumulate its way
 * into the wrong answer one sub-pixel at a time.
 *
 * From a CLOSED row only a LEFT drag (dx < 0) can claim the horizontal axis:
 * the tray lives on the right and there is nothing to reveal by dragging
 * right. A rightward drag resolves to `vertical`, parking the gesture with
 * the scroller and out of our way. From an OPEN row either direction counts,
 * because dragging right is how you put it back.
 */
export function decideAxis(
  dx: number,
  dy: number,
  current: SwipeAxis = 'undecided',
  fromOpen = false,
): SwipeAxis {
  if (current !== 'undecided') return current;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < SWIPE_SLOP) return 'undecided';
  if ((dx < 0 || fromOpen) && ax > ay * SWIPE_RATIO) return 'horizontal';
  return 'vertical';
}

/**
 * Where the row actually sits, given the drag so far.
 *
 * `base` is the offset the row rested at when the gesture started (0 closed,
 * -SWIPE_TRAY_WIDTH open), so the same function drives both opening and
 * closing. Clamped to [-tray, 0]: no rubber-band past the tray (there is
 * nothing further to reveal) and never positive (the row would tear away from
 * the left edge and show background).
 */
export function clampOffset(base: number, dx: number, tray: number = SWIPE_TRAY_WIDTH): number {
  const x = base + dx;
  if (x > 0) return 0;
  if (x < -tray) return -tray;
  return x;
}

/**
 * Where a released gesture settles. There is no in-between resting state — a
 * half-open row is just a row whose name is clipped for no reason.
 *
 * Direction wins over position when the drag was a FLICK: a short sharp pull
 * left from closed opens, and a flick right from open closes, even though
 * neither crossed the latch line. Otherwise it is decided by position — past
 * SWIPE_LATCH of the tray, it opens. `dx` is the whole gesture's delta from
 * its origin, not the last frame's.
 */
export function settleOpen(offset: number, dx: number, tray: number = SWIPE_TRAY_WIDTH): boolean {
  if (dx <= -SWIPE_FLICK) return true;
  if (dx >= SWIPE_FLICK) return false;
  return Math.abs(offset) >= tray * SWIPE_LATCH;
}
