import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The selected row's accent block must survive a SHUFFLE of the stylesheets.
 *
 * ─── The defect this pins ────────────────────────────────────────────────
 * Two rules both set `background-color` on the same element on mobile:
 *
 *   NavTree.css   .navtree-tab-row[data-active="true"]   { … var(--accent) }
 *   SwipeRow.css  .swiperow-face .navtree-tab-row        { … transparent   }
 *
 * As written, both were (0,2,0) — one class + one attribute vs. two classes —
 * so the cascade fell through to SOURCE ORDER, and the accent won only because
 * `NavTree.tsx` imports `./SwipeRow` (and with it SwipeRow.css) above its own
 * `./NavTree.css`. Nothing declares that dependency. Sorting the import block,
 * moving the SwipeRow import, or a bundler emitting the two sheets into
 * differently-ordered chunks would each have turned the selected chat
 * transparent on every phone, and no test would have noticed.
 *
 * ─── Why the assertion is written this way ───────────────────────────────
 * Asserting that SwipeRow.css *contains* `:not([data-active="true"])` would
 * restate the fix rather than test it. So this loads the REAL sheets into
 * jsdom in the HOSTILE order — SwipeRow last, the order that loses today —
 * and asks the cascade what the row is painted. A rule that wins under both
 * orders wins on specificity, which is the actual property.
 *
 * jsdom has no layout engine, but it does have a cascade, and cascade is the
 * whole subject here. It does not resolve custom properties, so a winning
 * `var(--accent)` comes back as the literal string — which is a perfectly good
 * marker for "the accent rule won", and is asserted as such.
 */

const css = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');

/**
 * Mount both sheets in the given order, plus one swipeable sheet row, and
 * return the resolved `background-color` of the active and idle rows.
 */
function paint(order: 'nav-last' | 'swipe-last'): { active: string; idle: string } {
  const nav = `<style>${css('NavTree.css')}</style>`;
  const swipe = `<style>${css('SwipeRow.css')}</style>`;
  document.head.innerHTML = order === 'swipe-last' ? nav + swipe : swipe + nav;
  // The mobile sheet's shape: a swipe shell wrapping the face, and the tab
  // rows inside it. Only the attributes the two rules key on matter.
  document.body.innerHTML = `
    <div class="navtree" data-variant="sheet">
      <div class="swiperow">
        <div class="swiperow-face">
          <div id="active" class="navtree-tab-row" data-active="true"></div>
        </div>
      </div>
      <div class="swiperow">
        <div class="swiperow-face">
          <div id="idle" class="navtree-tab-row"></div>
        </div>
      </div>
    </div>`;
  const bg = (id: string) =>
    getComputedStyle(document.getElementById(id) as HTMLElement).backgroundColor;
  return { active: bg('active'), idle: bg('idle') };
}

/** jsdom's spelling of `transparent` once it has been through the cascade. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

describe('the mobile selected row is accent-filled regardless of sheet order', () => {
  it('keeps the accent when SwipeRow.css is loaded LAST', () => {
    // The order that loses on a tie, and therefore the whole test. Today's
    // build happens to produce the other one.
    const { active } = paint('swipe-last');
    expect(active).not.toBe(TRANSPARENT);
    expect(active).toContain('--accent');
  });

  it('keeps the accent when NavTree.css is loaded last', () => {
    // The order the app currently ships. Asserted too, so the pair together
    // says "order does not decide this" rather than "the other order works".
    const { active } = paint('nav-last');
    expect(active).not.toBe(TRANSPARENT);
    expect(active).toContain('--accent');
  });

  it('still clears the fill on an UNSELECTED row, in both orders', () => {
    // The guard must not have been bought by disabling the rule. An unselected
    // row inside the sliding face is still transparent, so the face's own
    // surface is what shows and the row does not read as a full-bleed band the
    // moment it moves.
    expect(paint('swipe-last').idle).toBe(TRANSPARENT);
    expect(paint('nav-last').idle).toBe(TRANSPARENT);
  });
});
