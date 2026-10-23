import { describe, expect, it } from 'vitest';
import {
  FrameRing,
  type FrameSample,
  MAX_FRAMES_PER_NOTE,
  PRE_ROLL_MS,
  aHash,
  hamming,
  movedBy,
  sameFrame,
} from './frames';

const sample = (
  atMs: number,
  hash: string,
  cursor: { x: number; y: number } | null = null,
): FrameSample<string> => ({ atMs, hash, cursor, payload: `f${atMs}` });

/** A 256-cell greyscale map, half dark half bright — a stand-in for a screen. */
const map = (seed: number) =>
  Array.from({ length: 256 }, (_, i) => ((i * 7 + seed) % 255 > 127 ? 200 : 20));

describe('aHash / hamming', () => {
  it('is 64 hex chars — 256 bits, one per cell', () => {
    expect(aHash(map(0))).toHaveLength(64);
  });

  it('calls the same screen the same', () => {
    expect(hamming(aHash(map(3)), aHash(map(3)))).toBe(0);
    expect(sameFrame(aHash(map(3)), aHash(map(3)))).toBe(true);
  });

  it('calls a different screen different', () => {
    expect(sameFrame(aHash(map(0)), aHash(map(40)))).toBe(false);
  });

  it('absorbs a few noisy cells but not a repaint', () => {
    const base = map(5);
    const noisy: number[] = [...base];
    noisy[0] = 255; // one cell flips
    expect(hamming(aHash(base), aHash(noisy))).toBeLessThanOrEqual(4);
    expect(sameFrame(aHash(base), aHash(noisy))).toBe(true);
  });

  it('refuses to compare maps of different sizes', () => {
    expect(hamming('abcd', 'abcdef')).toBe(Number.POSITIVE_INFINITY);
  });

  it('is empty for no pixels', () => {
    expect(aHash([])).toBe('');
  });
});

describe('FrameRing dedupe', () => {
  it('drops an idle repeat', () => {
    const ring = new FrameRing<string>();
    expect(ring.push(sample(0, 'aaaa'), { speaking: false })).toBe(true);
    expect(ring.push(sample(300, 'aaaa'), { speaking: false })).toBe(false);
    expect(ring.size).toBe(1);
  });

  it('NEVER drops a repeat while somebody is talking — the spike bug', () => {
    // Identical screen, cursor moved from the video player to the button. A
    // content hash cannot see that; dedupe here pointed two notes at one
    // picture.
    const ring = new FrameRing<string>();
    ring.push(sample(0, 'aaaa', { x: 0.2, y: 0.3 }), { speaking: true });
    expect(ring.push(sample(300, 'aaaa', { x: 0.8, y: 0.6 }), { speaking: true })).toBe(true);
    expect(ring.size).toBe(2);
  });

  it('keeps the held frame looking recent while idle', () => {
    const ring = new FrameRing<string>();
    ring.push(sample(0, 'aaaa'), { speaking: false });
    ring.push(sample(5000, 'aaaa'), { speaking: false });
    expect(ring.all()[0]?.atMs).toBe(5000);
  });

  it('evicts by age', () => {
    const ring = new FrameRing<string>(1000);
    ring.push(sample(0, 'aaaa'), { speaking: true });
    ring.push(sample(900, 'bbbb'), { speaking: true });
    ring.push(sample(1600, 'cccc'), { speaking: true });
    expect(ring.all().map((s) => s.hash)).toEqual(['bbbb', 'cccc']);
  });
});

describe('FrameRing.pick', () => {
  const spanRing = () => {
    const ring = new FrameRing<string>();
    // 3 samples/second over four seconds, every one a different screen.
    for (let i = 0; i < 12; i++)
      ring.push(sample(i * 333, `${i.toString(16).repeat(4)}`, { x: i / 12, y: 0.5 }), {
        speaking: true,
      });
    return ring;
  };

  it('takes at most MAX frames, in time order', () => {
    const picked = spanRing().pick(0, 4000);
    expect(picked.length).toBeLessThanOrEqual(MAX_FRAMES_PER_NOTE);
    expect(picked.map((p) => p.atMs)).toEqual([...picked.map((p) => p.atMs)].sort((a, b) => a - b));
  });

  it('anchors on the start of the utterance, reaching into the pre-roll', () => {
    // People point, THEN talk: the frame half a second before the sentence is
    // the one with the cursor on the thing.
    const ring = new FrameRing<string>();
    ring.push(sample(1000, 'aaaa', { x: 0.1, y: 0.1 }), { speaking: false });
    ring.push(sample(2000, 'bbbb', { x: 0.9, y: 0.9 }), { speaking: true });
    const picked = ring.pick(2000 + PRE_ROLL_MS - 100, 3500);
    expect(picked[0]?.hash).toBe('bbbb');
  });

  it('spreads across a long utterance rather than taking the first few', () => {
    const picked = spanRing().pick(0, 4000);
    const last = picked[picked.length - 1]?.atMs ?? 0;
    expect(last).toBeGreaterThan(2000);
  });

  it('keeps an identical screen whose cursor moved, drops one that did not', () => {
    const ring = new FrameRing<string>();
    ring.push(sample(0, 'aaaa', { x: 0.1, y: 0.1 }), { speaking: true });
    ring.push(sample(300, 'aaaa', { x: 0.1, y: 0.105 }), { speaking: true }); // a jitter
    ring.push(sample(600, 'aaaa', { x: 0.9, y: 0.8 }), { speaking: true }); // moved
    const picked = ring.pick(0, 900);
    expect(picked).toHaveLength(2);
    expect(picked.map((p) => p.cursor?.x)).toEqual([0.1, 0.9]);
  });

  it('falls back to the nearest frame when the span caught none', () => {
    const ring = new FrameRing<string>();
    ring.push(sample(0, 'aaaa'), { speaking: true });
    const picked = ring.pick(30_000, 31_000);
    expect(picked.map((p) => p.hash)).toEqual(['aaaa']);
  });

  it('is empty with nothing captured', () => {
    expect(new FrameRing<string>().pick(0, 1000)).toEqual([]);
  });
});

describe('movedBy', () => {
  it('treats an unknown position as somewhere else', () => {
    expect(movedBy(null, { x: 0, y: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(movedBy({ x: 0, y: 0 }, { x: 0.3, y: 0.4 })).toBeCloseTo(0.5);
  });
});
