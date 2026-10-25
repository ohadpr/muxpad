import { describe, expect, it } from 'vitest';
import { type GrayMap, centroidOf, changedMask, cursorsFor, findCursor } from './cursor';

const W = 48;
const H = 36;

/** A still screen with a 2×2 "cursor" at (cx, cy). */
function screen(cx: number | null, cy: number | null, base = 40): GrayMap {
  const data = new Uint8Array(W * H).fill(base);
  if (cx !== null && cy !== null) {
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) data[(cy + dy) * W + (cx + dx)] = 230;
  }
  return { w: W, h: H, data };
}

describe('findCursor', () => {
  it('puts the pointer where it IS, not where it was', () => {
    // The two-frame diff lights up both (4,4) and (30,20); only the
    // intersection of both diffs is the middle frame's own position.
    const found = findCursor(screen(4, 4), screen(30, 20), screen(40, 30));
    expect(found).not.toBeNull();
    expect((found as { x: number }).x).toBeCloseTo((30 + 0.5) / W, 1);
    expect((found as { y: number }).y).toBeCloseTo((20 + 0.5) / H, 1);
  });

  it('declines without both neighbours rather than guessing', () => {
    expect(findCursor(null, screen(10, 10), screen(20, 20))).toBeNull();
    expect(findCursor(screen(10, 10), screen(20, 20), null)).toBeNull();
  });

  it('declines when the pointer did not move', () => {
    expect(findCursor(screen(10, 10), screen(10, 10), screen(10, 10))).toBeNull();
  });

  it('declines on a scroll — most of the screen moved, there is no pointer', () => {
    const a: GrayMap = { w: W, h: H, data: new Uint8Array(W * H).fill(30) };
    const b: GrayMap = { w: W, h: H, data: new Uint8Array(W * H).fill(200) };
    const c: GrayMap = { w: W, h: H, data: new Uint8Array(W * H).fill(30) };
    expect(findCursor(a, b, c)).toBeNull();
  });

  it('ignores JPEG-grade noise', () => {
    const still = screen(10, 10);
    const noisy = screen(10, 10);
    const data = noisy.data as Uint8Array;
    for (let i = 0; i < data.length; i += 7) data[i] = (data[i] as number) + 8;
    expect(findCursor(still, noisy, still)).toBeNull();
  });

  it('declines when the maps are different sizes', () => {
    const small: GrayMap = { w: 4, h: 4, data: new Uint8Array(16) };
    expect(findCursor(small, screen(10, 10), screen(20, 20))).toBeNull();
  });
});

describe('changedMask / centroidOf', () => {
  it('marks only the cells that differ', () => {
    const mask = changedMask(screen(null, null), screen(5, 5));
    expect(Array.from(mask).filter(Boolean)).toHaveLength(4);
  });

  it('is empty for mismatched sizes', () => {
    expect(changedMask({ w: 2, h: 2, data: [0, 0, 0, 0] }, screen(1, 1)).length).toBe(0);
  });

  it('centroid is null for an empty mask', () => {
    expect(centroidOf(new Uint8Array(W * H), W, H)).toBeNull();
  });
});

describe('cursorsFor', () => {
  it('fills a run, leaving the ends unknown', () => {
    const got = cursorsFor([screen(2, 2), screen(10, 10), screen(20, 20), screen(30, 30)]);
    expect(got[0]).toBeNull();
    expect(got[3]).toBeNull();
    expect(got[1]).not.toBeNull();
    expect(got[2]).not.toBeNull();
  });
});
