import { describe, expect, it } from 'vitest';
import {
  FX_DECAY_MS,
  FX_RADIUS,
  type FxState,
  cellFalloff,
  fxWanted,
  nextFx,
} from './demoscene-fx';

/**
 * THE EFFECT HAS TO BE QUIET WHEN NOBODY IS MOVING.
 *
 * It sits over a READING SURFACE, which is the worst place in the app for
 * motion — so the interesting property is not that it lights up, it is that it
 * goes away and stays away. That is arithmetic, and arithmetic can be checked
 * without a browser.
 */
const at = (x: number, y: number, intensity: number): FxState => ({ x, y, intensity });

describe('the pointer interference', () => {
  it('fades to nothing while the pointer is still', () => {
    let s = at(100, 100, 1);
    for (let i = 0; i < 12; i++) s = nextFx(s, { x: 100, y: 100, dtMs: 500, moved: 0 });
    expect(s.intensity).toBeLessThan(0.01);
  });

  it('decays by roughly 1/e over its own decay constant', () => {
    const s = nextFx(at(0, 0, 1), { x: 0, y: 0, dtMs: FX_DECAY_MS, moved: 0 });
    expect(s.intensity).toBeCloseTo(1 / Math.E, 2);
  });

  it('a resting hand cannot SUSTAIN the glow — jitter is not movement', () => {
    // The property is monotone decay under sub-threshold movement, not a
    // particular number at a particular time: from 0.5, a 900ms constant still
    // leaves 0.054 after two seconds, and asserting "< 0.01" there would be
    // this test inventing a deadline the effect never promised.
    let s = at(10, 10, 0.5);
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      s = nextFx(s, { x: 11, y: 10, dtMs: 100, moved: 1 });
      seen.push(s.intensity);
    }
    for (let i = 1; i < seen.length; i++)
      expect(seen[i] as number).toBeLessThan(seen[i - 1] as number);
    expect(s.intensity).toBeLessThan(0.1);
    // …and it does reach nothing, given its own time.
    for (let i = 0; i < 40; i++) s = nextFx(s, { x: 11, y: 10, dtMs: 100, moved: 1 });
    expect(s.intensity).toBeLessThan(0.001);
  });

  it('brightens with movement but never past full', () => {
    let s = at(0, 0, 0);
    for (let i = 0; i < 40; i++) s = nextFx(s, { x: i * 50, y: 0, dtMs: 16, moved: 400 });
    expect(s.intensity).toBe(1);
  });

  it('follows the pointer exactly — the light is where the hand is', () => {
    const s = nextFx(at(0, 0, 0.4), { x: 640, y: 480, dtMs: 16, moved: 30 });
    expect([s.x, s.y]).toEqual([640, 480]);
  });

  it('exists only for the demoscene theme, and never under reduced motion', () => {
    expect(fxWanted('demoscene', false)).toBe(true);
    expect(fxWanted('demoscene', true)).toBe(false);
    expect(fxWanted('tokyo-night', false)).toBe(false);
    expect(fxWanted(null, false)).toBe(false);
  });
});

describe('the disturbed region', () => {
  it('falls to nothing at the radius — no circle drawn on the screen', () => {
    expect(cellFalloff(FX_RADIUS, 1)).toBe(0);
    expect(cellFalloff(FX_RADIUS + 50, 1)).toBe(0);
  });

  it('is strongest under the pointer and eases outward', () => {
    const near = cellFalloff(0, 1);
    const mid = cellFalloff(FX_RADIUS / 2, 1);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(cellFalloff(FX_RADIUS * 0.9, 1));
  });

  it('scales with intensity, so a faded effect disturbs nothing', () => {
    expect(cellFalloff(10, 0)).toBe(0);
    expect(cellFalloff(10, 0.5)).toBeCloseTo(cellFalloff(10, 1) / 2, 5);
  });
});
