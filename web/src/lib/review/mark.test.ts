import { describe, expect, it, vi } from 'vitest';
import { INSET_FRACTION, drawMark, placeInset, placeRing } from './mark';

const W = 1280;
const H = 720;

describe('placeInset', () => {
  it('puts the close-up in the corner furthest from the pointer', () => {
    // The one hard rule: an annotation must not cover the thing it annotates.
    const topLeft = placeInset(W, H, { x: 0.1, y: 0.1 }).dest;
    expect(topLeft.x).toBeGreaterThan(W / 2);
    expect(topLeft.y).toBeGreaterThan(H / 2);

    const bottomRight = placeInset(W, H, { x: 0.9, y: 0.9 }).dest;
    expect(bottomRight.x).toBeLessThan(W / 2);
    expect(bottomRight.y).toBeLessThan(H / 2);
  });

  it('sizes the close-up as a fraction of the frame', () => {
    const { dest } = placeInset(W, H, { x: 0.5, y: 0.2 });
    expect(dest.w).toBe(Math.round(W * INSET_FRACTION));
    expect(dest.w).toBe(dest.h);
  });

  it('stays inside the frame', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 },
    ]) {
      const { dest, src } = placeInset(W, H, p);
      expect(dest.x).toBeGreaterThanOrEqual(0);
      expect(dest.y).toBeGreaterThanOrEqual(0);
      expect(dest.x + dest.w).toBeLessThanOrEqual(W);
      expect(dest.y + dest.h).toBeLessThanOrEqual(H);
      expect(src.x).toBeGreaterThanOrEqual(0);
      expect(src.y).toBeGreaterThanOrEqual(0);
      expect(src.x + src.w).toBeLessThanOrEqual(W);
      expect(src.y + src.h).toBeLessThanOrEqual(H);
    }
  });

  it('shows a FULL box for a cursor in the corner, not a stretched sliver', () => {
    const corner = placeInset(W, H, { x: 0, y: 0 }).src;
    const middle = placeInset(W, H, { x: 0.5, y: 0.5 }).src;
    expect(corner.w).toBe(middle.w);
    expect(corner.h).toBe(middle.h);
  });

  it('centres the close-up on the pointer when there is room', () => {
    const { src } = placeInset(W, H, { x: 0.5, y: 0.5 });
    expect(src.x + src.w / 2).toBeCloseTo(W / 2, 0);
    expect(src.y + src.h / 2).toBeCloseTo(H / 2, 0);
  });
});

describe('placeRing', () => {
  it('rings the pointer, scaled to the frame', () => {
    const r = placeRing(W, H, { x: 0.25, y: 0.5 });
    expect(r.x).toBe(320);
    expect(r.y).toBe(360);
    expect(r.r).toBeGreaterThan(10);
    expect(r.r).toBeLessThan(H / 4);
  });
});

describe('drawMark', () => {
  const ctx = () =>
    ({
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      setLineDash: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      imageSmoothingEnabled: false,
    }) as unknown as Parameters<typeof drawMark>[0] & { [k: string]: ReturnType<typeof vi.fn> };

  it('draws nothing when the cursor was never found — unmarked beats wrong', () => {
    const c = ctx();
    drawMark(c, {} as CanvasImageSource, W, H, null);
    expect(c.save).not.toHaveBeenCalled();
    expect(c.drawImage).not.toHaveBeenCalled();
  });

  it('rings the pointer and copies the close-up out of the frame', () => {
    const c = ctx();
    drawMark(c, {} as CanvasImageSource, W, H, { x: 0.3, y: 0.4 });
    expect(c.arc).toHaveBeenCalled();
    expect(c.drawImage).toHaveBeenCalledTimes(1);
    // 9-argument form: source rect → destination rect.
    expect(vi.mocked(c.drawImage).mock.calls[0]).toHaveLength(9);
    expect(c.restore).toHaveBeenCalled();
  });
});
