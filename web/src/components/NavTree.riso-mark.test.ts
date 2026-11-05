import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RISO'S WORKING MARK IS TWO INK DOTS, NOT A CUT RING.
 *
 * The shared mark is a 10px circle with a 1.5px stroke and one quadrant
 * removed. On every other theme that is an amber arc on a dark grey rail, so
 * the way a thin curve aliases at 10px never shows. Riso puts `#ffd84d` on
 * `#1333c4` — about as far apart as two inks get — and at that contrast the
 * stair-stepping and the hard cut become the two loudest things in the mark.
 * It reads as a chunky yellow "U" flipping about rather than a ring turning.
 *
 * A filled circle aliases better than a thin arc, because its edge is where
 * the colour IS rather than where it stops. And two ink dots going round is
 * what a risograph actually looks like: one flat spot ink per pass,
 * registration marks, overprint.
 */
const CSS = readFileSync(join(__dirname, 'NavTree.css'), 'utf8');
const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel: string): string => {
  const i = flat.indexOf(sel);
  return i === -1 ? '' : flat.slice(i, flat.indexOf('}', i) + 1);
};

describe('the riso working mark', () => {
  const riso = rule('[data-theme="riso"] .navtree-mark[data-state="working"]');

  it('exists, and drops the stroke that was aliasing', () => {
    expect(riso).not.toBe('');
    expect(riso).toMatch(/border:\s*0/);
  });

  it('draws two dots, the second one lighter — the overprint read', () => {
    expect(riso.match(/radial-gradient/g) ?? []).toHaveLength(2);
    expect(riso).toMatch(/color-mix\(in srgb, var\(--status-working\) 55%/);
  });

  it('declares NO animation of its own', () => {
    // One keyframe in this rail is pinned by StateChip.test — two that agree
    // today are two that can disagree tomorrow. Riso changes the DRAWING and
    // rides the same spin.
    expect(riso).not.toContain('animation');
  });

  it('still collapses to a solid mark under reduced motion', () => {
    // The generic fallback sets `background`, and this theme's own rule sets
    // `background` at higher specificity — so without an arm of its own, riso
    // would get two STATIC dots, which is "indistinguishable from a
    // decoration", the one outcome that fallback exists to avoid.
    const start = flat.indexOf('@media (prefers-reduced-motion: reduce)');
    const block = flat.slice(
      start,
      flat.indexOf('\n}', flat.indexOf('[data-theme="riso"]', start)),
    );
    expect(block).toMatch(/\[data-theme="riso"\][^}]*background:\s*var\(--status-working\)/);
  });
});
