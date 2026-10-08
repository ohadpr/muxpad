import { describe, expect, it } from 'vitest';
import { cardFreshness } from './cards.js';

describe('cardFreshness — the rail that replaced the timestamp', () => {
  const day = 86_400_000;
  const at = (ageMs: number, every: number | null = day) => ({
    every_ms: every,
    updated_at: 1_000_000_000,
    now: 1_000_000_000 + ageMs,
  });

  it('is full on arrival', () => {
    const c = at(0);
    expect(cardFreshness(c, c.now)).toBe(1);
  });

  it('decays across ONE cadence, not across the stale grace', () => {
    // By the time a card is DUE it should already look like it is waiting; the
    // grace period exists to be tolerant of lateness, not to hide it.
    const c = at(day / 2);
    expect(cardFreshness(c, c.now)).toBeCloseTo(0.5, 5);
    const d = at(day);
    expect(cardFreshness(d, d.now)).toBe(0);
  });

  it('never goes below zero, however long the writer has been gone', () => {
    const c = at(day * 40);
    expect(cardFreshness(c, c.now)).toBe(0);
  });

  it('is FULL for a card that never declared a cadence', () => {
    // Not "unknown, so dim it". A writer that never promised to come back is
    // not late, and fading it would invent a decay with no period to measure
    // against — the same reasoning cardIsStale uses to return false here.
    const c = at(day * 999, null);
    expect(cardFreshness(c, c.now)).toBe(1);
  });

  it('survives a clock that went backwards', () => {
    const c = at(-5000);
    expect(cardFreshness(c, c.now)).toBe(1);
  });
});
