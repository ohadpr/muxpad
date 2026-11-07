import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE DRAWER HIDES THE JUMP-TO-LATEST ARROW.
 *
 * Reported: "down arrow hovers over drawer. drawer should hide it." The arrow
 * carries `z-index: 6` and so does the drawer, so it painted on top — a
 * jump-to-latest button floating over a panel whose content it cannot scroll.
 *
 * It is HIDDEN rather than layered under: the panel is inset from the pane's
 * edges with a radius, so an arrow behind it would still show through the strip
 * of conversation left visible on either side, which is worse than either.
 */
const SRC = readFileSync(join(import.meta.dirname, 'ChatPane.tsx'), 'utf8');
const CSS = readFileSync(join(import.meta.dirname, 'ChatPane.css'), 'utf8');

describe('the jump-to-latest arrow', () => {
  it('does not render while the drawer is open', () => {
    expect(SRC).toContain('{showScrollDown && !drawerOpen ? (');
  });

  it('is rendered from exactly one place, still gated', () => {
    // Guards against the condition being widened, or a second render site
    // appearing without the gate.
    expect(SRC.match(/\{showScrollDown/g)).toHaveLength(1);
    expect(SRC).not.toContain('{showScrollDown ? (');
  });

  it('shares the drawer’s stacking level, which is why the gate is needed', () => {
    // If the arrow ever drops below the drawer in z-order this test is the
    // place to find out, because then hiding it is a choice rather than a fix.
    const arrow = CSS.match(/\.chat-scroll-down \{([^}]*)\}/)?.[1] ?? '';
    expect(arrow).toMatch(/z-index:\s*6/);
  });
});
