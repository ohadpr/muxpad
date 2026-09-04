/**
 * How tall the mobile nav sheet is allowed to be, given where the screen
 * ACTUALLY ends — which, once a software keyboard is up, is not where CSS
 * thinks it is.
 *
 * ─── The bug this exists to prevent ──────────────────────────────────────
 * `.mns-panel` is `position: fixed` and capped at `100svh - top - 48px`.
 * `svh` is a LAYOUT viewport unit, and on iOS Safari the layout viewport does
 * not shrink when the keyboard opens — only `visualViewport` does. Modern
 * Chrome behaves the same way (`interactive-widget: resizes-visual` has been
 * the default since 108). So with the search box focused the panel keeps its
 * full-screen height, its scroller's content fits inside that height, and the
 * scroller therefore has NO OVERFLOW: the rows that fall below the keyboard
 * line are not merely off-screen, they are unreachable, because there is
 * nothing to scroll. Measured at 390×844 with a one-character query: 5 of 12
 * results hidden, `scrollHeight === clientHeight`, `maxScrollTop === 0`.
 *
 * Capping the panel by the VISUAL viewport restores the overflow, and the
 * scroller does the rest.
 *
 * This is deliberately scoped to the sheet. `main.tsx` explains why there is
 * no GLOBAL visualViewport height mirror: it re-sized the pane box on every
 * URL-bar twitch and garbled TUI scrollback through the xterm → PTY resize
 * cascade. The sheet contains no terminal, is mounted only while open, and
 * `MobileInputBar` already tracks the same signal the same way.
 */

/** The visual viewport, reduced to the two numbers that decide the cap. */
export interface VisualViewportish {
  /** `visualViewport.height` — the band NOT covered by the keyboard. */
  height: number;
  /** `visualViewport.offsetTop` — how far it has scrolled inside the layout
   *  viewport. iOS adds this when it scrolls a focused field into view; the
   *  panel is fixed to the LAYOUT viewport, so it has to be added back. */
  offsetTop: number;
}

/**
 * Never collapse the sheet to a sliver. A landscape phone with a keyboard up
 * leaves very little, and a 0px panel would read as "the sheet vanished when I
 * tapped search" — strictly worse than a couple of rows you can scroll.
 */
export const MIN_SHEET_HEIGHT = 140;

/**
 * The panel's max-height, in CSS px.
 *
 * @param vp        the visual viewport, or `null` where it is unsupported —
 *                  in which case there is nothing to correct for and the
 *                  caller should leave the stylesheet's `svh` cap alone.
 * @param panelTop  the panel's own `top`, in layout-viewport coordinates.
 * @param margin    the band of scrim kept below it so "tap outside to
 *                  dismiss" always has somewhere to land.
 */
export function sheetMaxHeight(
  vp: VisualViewportish | null,
  panelTop: number,
  margin: number,
): number | null {
  if (!vp) return null;
  const bottom = vp.offsetTop + vp.height;
  return Math.max(MIN_SHEET_HEIGHT, bottom - panelTop - margin);
}

/**
 * The scrim's bottom band, kept in step with the panel's cap. Mirrors the
 * `- 48px` in MobileNavSwitcher.css; exported so the two cannot drift.
 */
export const SHEET_BOTTOM_MARGIN = 48;
