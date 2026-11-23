import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RISO'S WORKING MARK IS A REGISTRATION MARK, OUT OF REGISTER.
 *
 * It was two ink dots riding the shared spin, after a cut ring aliased into "a
 * chunky yellow U flipping about" at riso's contrast. Then every theme got a
 * working mark of its own ("i hate these working indicators … for each theme
 * come up with something better/different — more normative but with a
 * twist"), and riso's is the print process's own target: a crosshair in a
 * circle turning (a spinner anybody reads) over a still ghost of itself in the
 * second ink, a pixel off — the drum that never quite lands.
 *
 * Rewritten rather than deleted: what the old file guarded still holds and is
 * pinned here — the drawing is FILLED gradients, not a stroked arc, and reduced
 * motion leaves a complete mark rather than a fainter one.
 */
const flat = readFileSync(join(__dirname, 'StatusMark.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  sel: (m[1] ?? '').trim(),
  body: m[2] ?? '',
}));
const riso = (layer: '::before' | '::after') =>
  rules
    .filter((r) => r.sel.includes('[data-theme="riso"]') && r.sel.includes(layer))
    .map((r) => r.body)
    .join('\n');

describe('the riso working mark', () => {
  it('exists on both layers, and is drawn in fills, not a stroked arc', () => {
    expect(riso('::before')).not.toBe('');
    expect(riso('::after')).not.toBe('');
    expect(`${riso('::before')}${riso('::after')}`).toMatch(/radial-gradient/);
    expect(`${riso('::before')}${riso('::after')}`).not.toMatch(/border:/);
  });

  it('the ghost is the second ink, a pixel off, and STILL', () => {
    const ghost = rules.filter(
      (r) =>
        r.sel.includes('[data-theme="riso"]') &&
        r.sel.includes('::before') &&
        !r.sel.includes('::after'),
    );
    const body = ghost.map((r) => r.body).join('\n');
    expect(body).toMatch(/--c:\s*color-mix\(in srgb, var\(--accent\)/);
    expect(body).toMatch(/transform:\s*translate\(1px, 1px\)/);
    expect(body).not.toMatch(/animation:/);
  });

  it('only the first ink turns', () => {
    const turning = rules.filter(
      (r) =>
        r.sel.includes('[data-theme="riso"]') &&
        r.sel.includes('::after') &&
        /animation:/.test(r.body),
    );
    expect(turning).toHaveLength(1);
    expect(turning[0]?.body).toMatch(/--c:\s*var\(--wm-ink\)/);
  });

  it('reduced motion stops the turn and keeps the whole mark', () => {
    const start = flat.indexOf('@media (prefers-reduced-motion: reduce)', flat.indexOf('EVERY'));
    const block = flat.slice(
      Math.max(start, flat.lastIndexOf('@media (prefers-reduced-motion: reduce)')),
    );
    expect(block).toMatch(/\.navtree-mark\[data-state="working"\]::after[\s\S]*animation:\s*none/);
    // …and nothing in it touches opacity: a fainter mark is the one thing the
    // reduced-motion fallback must never be.
    expect(block).not.toMatch(/opacity/);
  });
});
