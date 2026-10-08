import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE WORKING INDICATOR HAS NO EDGE, AND THAT IS THE WHOLE DESIGN.
 *
 * It replaced three bouncing dots — the universal answer, which says nothing a
 * hundred other apps are not already saying. What makes this one different is
 * not the motion, it is that there is no containing shape: two counter-rotating
 * line gratings masked to zero intensity in every direction, so the pattern
 * thins out rather than stopping at a boundary.
 *
 * Each rule below is load-bearing for that, and each has an obvious-looking
 * "tidy-up" that would quietly destroy it.
 */
const css = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? null : css.slice(i, css.indexOf('}', i));
};

describe('the working indicator', () => {
  it('is masked, which is the only reason it has no edge', () => {
    // Without this it is a visible rectangle of hatching and the entire point
    // is gone — it becomes a widget in a box like every other spinner.
    const r = rule('.chat-typing') ?? '';
    expect(r).toMatch(/-webkit-mask:\s*radial-gradient/);
    expect(r).toMatch(/\bmask:\s*radial-gradient/);
  });

  it('overhangs its window on every side', () => {
    // A layer rotating about its own centre must be far larger than what you
    // see of it, or its own corners sweep through the view — which would be an
    // edge, reintroduced by the thing meant to hide edges.
    expect(rule('.chat-typing i')).toMatch(/inset:\s*-\d+%/);
  });

  it('uses two periods that share no common factor', () => {
    // 13 and 17: the beat runs ~221s, so it never lands twice in a sitting and
    // two panes started at different moments look different. Round numbers
    // (10s/20s) would resynchronise every 20 seconds and read as a loop.
    const a = (rule('.chat-typing i:nth-child(1)') ?? '').match(/(\d+)s/)?.[1];
    const b = (rule('.chat-typing i:nth-child(2)') ?? '').match(/(\d+)s/)?.[1];
    const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(gcd(Number(a), Number(b))).toBe(1);
  });

  it('breaks the symmetry between the two layers', () => {
    // Identical layers at mirrored angles make a symmetric figure, which reads
    // as a drawn object rather than as interference. The scale is what makes
    // the pattern wander.
    expect(rule('@keyframes chat-drift-b')).toContain('scale(');
    expect(rule('@keyframes chat-drift-a')).not.toContain('scale(');
  });

  it('animates nothing but transform', () => {
    // Several panes can be working at once. Transform-only stays on the
    // compositor and never touches layout or paint; this is the property that
    // chose it over the prettier candidates.
    for (const k of ['@keyframes chat-drift-a', '@keyframes chat-drift-b']) {
      const r = rule(k) ?? '';
      expect(r).toMatch(/transform:/);
      expect(r).not.toMatch(/(width|height|opacity|filter|background|left|top):/);
    }
  });

  it('holds a static frame under reduced motion', () => {
    // `animation: none`, not `display: none` — the row must not change height
    // for somebody who asked for less movement.
    const i = css.indexOf('prefers-reduced-motion');
    expect(css.slice(i, i + 220)).toContain('.chat-typing i');
    expect(css.slice(i, i + 220)).toContain('animation: none');
  });
});
