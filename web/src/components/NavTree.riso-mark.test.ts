import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RISO'S WORKING MARK IS TWO INKS GOING ROUND.
 *
 * History, because each step was a correction: a cut ring aliased into "a
 * chunky yellow U flipping about" at riso's contrast, so it became two ink
 * dots. Then every theme got its own mark and riso's became a registration
 * mark turning (a crosshair in a circle), which at row size reads as "+" (new)
 * or a locate target, a different muxpad concept, so it came back to the two
 * dots as the theme's own drawing: one flat spot of each ink, going round like
 * the drum.
 *
 * Pinned: the drawing is FILLED dots (a filled edge aliases better than a thin
 * arc), one in each ink, no crosshair, one moving layer, and reduced motion
 * stops it without touching opacity.
 */
const flat = readFileSync(join(__dirname, 'StatusMark.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  sel: (m[1] ?? '').trim(),
  body: m[2] ?? '',
}));
const riso = rules.filter((r) => r.sel.includes('[data-theme="riso"]'));

describe('the riso working mark', () => {
  it('is two filled dots, one in each ink, and no stroke', () => {
    const body = riso.map((r) => r.body).join('\n');
    expect(body.match(/radial-gradient/g) ?? []).toHaveLength(2);
    expect(body).toMatch(/var\(--wm-ink\)/);
    expect(body).toMatch(/var\(--accent\)/);
    expect(body).not.toMatch(/border:/);
  });

  it('has no crosshair — a "+" at the end of a row means "new"', () => {
    expect(riso.map((r) => r.body).join('\n')).not.toMatch(/linear-gradient/);
  });

  it('moves on one layer only', () => {
    const moving = riso.filter((r) => /animation:/.test(r.body));
    expect(moving).toHaveLength(1);
    expect(moving[0]?.sel).toContain('::after');
  });

  it('reduced motion stops it and keeps the whole mark', () => {
    const block = flat.slice(flat.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.navtree-mark\[data-state="working"\]::after[\s\S]*animation:\s*none/);
    expect(block).not.toMatch(/opacity/);
  });
});
