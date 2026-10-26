import { describe, expect, it } from 'vitest';
import {
  DROP_BAND,
  DROP_DIM,
  DROP_LIFE_MS,
  DROP_MAX_RADIUS,
  DROP_MIN_DISTANCE_PX,
  DROP_MIN_INTERVAL_MS,
  DROP_PEAK,
  DROP_SPEED,
  type Drop,
  GLYPHS,
  corruptLine,
  corruptionAt,
  fxWanted,
  liveDrops,
  ringMask,
  ringStrength,
  shouldDrop,
} from './demoscene-fx';

/**
 * RAIN DROPS, NOT A SPOTLIGHT.
 *
 * The build before this corrupted a disc of characters that followed the
 * cursor and faded slowly — "I want it to dissipate much faster and feel a bit
 * subtler", pointed at ASCII rain-drop animations. That is a different SHAPE,
 * not a different intensity: a drop is an event with a place and a birth time,
 * leaving one ring that expands, thins and dies.
 *
 * The arithmetic is the whole of the behaviour, and it is the only part that
 * can be checked without a browser — so the properties that matter (it goes
 * away, it stays thin, it never reflows the page) are pinned here.
 */
const drop = (x: number, y: number, born = 0): Drop => ({ x, y, born });

describe('a drop’s ring', () => {
  it('dies on its own, with no decay to wait out', () => {
    expect(ringStrength(0, DROP_LIFE_MS)).toBe(0);
    expect(ringStrength(100, DROP_LIFE_MS + 500)).toBe(0);
    expect(liveDrops([drop(0, 0, 0)], DROP_LIFE_MS + 1)).toEqual([]);
    expect(liveDrops([drop(0, 0, 0)], DROP_LIFE_MS - 1)).toHaveLength(1);
  });

  it('travels OUTWARD — the crest is further away as it ages', () => {
    const crest = (age: number) => {
      let best = 0;
      let bestD = 0;
      for (let d = 0; d < DROP_MAX_RADIUS; d += 1) {
        const v = ringStrength(d, age);
        if (v > best) {
          best = v;
          bestD = d;
        }
      }
      return bestD;
    };
    expect(crest(200)).toBeGreaterThan(crest(60));
    expect(crest(400)).toBeGreaterThan(crest(200));
  });

  it('is a thin band, not a disc — the centre is quiet once it has left', () => {
    // EARLY in the life, because the ring is also fading: by 400ms of a 620ms
    // life it is down to 0.13 on its own crest by design, and asserting a big
    // number there would be testing the fade rather than the band.
    const age = 120;
    const radius = (age / 1000) * 300;
    expect(ringStrength(radius, age)).toBeGreaterThan(0.5);
    // Well inside the ring, where a spotlight would still be blazing.
    expect(ringStrength(radius + DROP_BAND * 4, age)).toBeLessThan(0.05);
  });

  it('weakens as it ages, so a ring thins rather than vanishing mid-screen', () => {
    const at = (age: number) => ringStrength((age / 1000) * 300, age);
    expect(at(120)).toBeGreaterThan(at(300));
    expect(at(300)).toBeGreaterThan(at(520));
  });
});

describe('shedding drops', () => {
  it('always sheds the first one', () => {
    expect(shouldDrop(undefined, { x: 0, y: 0 }, 0)).toBe(true);
  });

  it('refuses to hammer one spot — that is what made it feel like a spotlight', () => {
    const last = drop(100, 100, 0);
    expect(shouldDrop(last, { x: 102, y: 101 }, DROP_MIN_INTERVAL_MS * 4)).toBe(false);
  });

  it('refuses to smear — a fast sweep leaves a trail, not a stripe', () => {
    const last = drop(100, 100, 0);
    expect(shouldDrop(last, { x: 400, y: 400 }, DROP_MIN_INTERVAL_MS - 10)).toBe(false);
  });

  it('sheds when both time and distance have passed', () => {
    const last = drop(100, 100, 0);
    expect(
      shouldDrop(last, { x: 100 + DROP_MIN_DISTANCE_PX, y: 100 }, DROP_MIN_INTERVAL_MS + 1),
    ).toBe(true);
  });
});

describe('corrupting the text itself', () => {
  const grid = (perLine: number) => (i: number) => ({
    x: (i % perLine) * 8,
    y: Math.floor(i / perLine) * 18,
  });
  const always = () => 0;
  const never = () => 0.999;
  // A ring that has just reached the start of the line.
  const onTheLine = [drop(0, 0, -100)];

  it('NEVER changes the length — a reflow would move the page under the reader', () => {
    const src = 'the quick brown fox jumps over the lazy dog';
    const out = corruptLine(src, grid(40), onTheLine, 0, always);
    expect(out).toHaveLength(src.length);
  });

  it('leaves whitespace alone, or damaged text reads as a bar chart', () => {
    const src = 'a b  c\td';
    const out = corruptLine(src, grid(40), onTheLine, 0, always);
    for (let i = 0; i < src.length; i++) {
      if (/\s/.test(src[i] as string)) expect(out[i]).toBe(src[i]);
    }
  });

  it('only uses the text-mode glyph set', () => {
    const src = 'abcdefghij';
    const out = corruptLine(src, grid(40), onTheLine, 0, always);
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== src[i]) expect(GLYPHS).toContain(out[i] as string);
    }
  });

  it('returns the SAME string when nothing is disturbed — no needless DOM writes', () => {
    const src = 'untouched';
    expect(corruptLine(src, grid(40), onTheLine, 0, never)).toBe(src);
    expect(corruptLine(src, grid(40), [], 0, always)).toBe(src);
    // Far from every ring: the common case, on most of the log, every frame.
    expect(corruptLine(src, grid(40), [drop(9999, 9999, 0)], 0, always)).toBe(src);
  });

  it('never corrupts a cell outright — it has to flicker back to stay readable', () => {
    expect(corruptionAt({ x: 0, y: 0 }, [drop(0, 0, 0)], 0)).toBeLessThan(1);
    expect(DROP_PEAK).toBeLessThan(0.5);
  });

  it('takes the strongest ring rather than stacking them', () => {
    // Overlapping drops must not add up into a solid block of noise.
    const many = [drop(0, 0, -100), drop(0, 0, -100), drop(0, 0, -100)];
    expect(corruptionAt({ x: 30, y: 0 }, many, 0)).toBeLessThanOrEqual(DROP_PEAK);
  });
});

describe('when the effect exists at all', () => {
  it('is demoscene-only, and never under reduced motion', () => {
    expect(fxWanted('demoscene', false)).toBe(true);
    expect(fxWanted('demoscene', true)).toBe(false);
    expect(fxWanted('tokyo-night', false)).toBe(false);
    expect(fxWanted(null, false)).toBe(false);
  });
});

/**
 * THE DIM IS WHAT MAKES IT A RIPPLE.
 *
 * "I don't see a ripple… make the ripple itself also adjust down the
 * brightness of characters by up to 15%." Corruption alone is scattered
 * glyphs; a band of dimmed text is a wave front you can follow.
 *
 * Done with a mask rather than with colour, because colour applies to
 * elements: per-character brightness would mean a span per glyph, which is the
 * cost this effect has refused from the start.
 */
describe('the ring dims what it crosses', () => {
  const box = { left: 0, top: 0, width: 600, height: 80 };
  const at = (age: number) => ringMask(box, [drop(300, 40, -age)], 0);

  it('dims by at most the stated amount, and never brightens', () => {
    for (let age = 0; age < DROP_LIFE_MS; age += 20) {
      const m = at(age);
      if (!m) continue;
      const alpha = Number(/rgba\(0,0,0,([\d.]+)\)/.exec(m)?.[1] ?? '1');
      expect(alpha).toBeLessThanOrEqual(1);
      expect(alpha).toBeGreaterThanOrEqual(1 - DROP_DIM - 1e-9);
    }
  });

  it('is strongest when the drop is young and eases off as it dies', () => {
    const alpha = (age: number) => Number(/rgba\(0,0,0,([\d.]+)\)/.exec(at(age) ?? '')?.[1] ?? '1');
    expect(alpha(60)).toBeLessThan(alpha(300));
    expect(alpha(300)).toBeLessThan(alpha(560));
  });

  it('puts the dark band exactly where the ring is', () => {
    const age = 200;
    const m = at(age) ?? '';
    const radius = (age / 1000) * DROP_SPEED;
    expect(m).toContain(`${radius.toFixed(1)}px`);
  });

  it('declines to mask a paragraph no ring reaches — no identity masks', () => {
    expect(ringMask(box, [drop(5000, 5000, 0)], 0)).toBeNull();
    expect(ringMask(box, [], 0)).toBeNull();
    expect(ringMask(box, [drop(300, 40, -DROP_LIFE_MS - 1)], 0)).toBeNull();
  });
});
