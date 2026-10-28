import { describe, expect, it } from 'vitest';
import { AUTO_COMPACT_PCT, AUTO_COMPACT_REARM_PCT, AutoCompactor } from './auto-compact.js';

describe('automatic compaction', () => {
  it('leaves a half-full conversation alone', () => {
    const a = new AutoCompactor();
    for (const pct of [0, 25, 60, 89]) expect(a.consider(pct, false), `${pct}%`).toBe(false);
  });

  it('fires once the fill reaches the threshold', () => {
    expect(new AutoCompactor().consider(AUTO_COMPACT_PCT, false)).toBe(true);
  });

  it('never fires mid-turn, because /compact rides the turn queue', () => {
    // Queued behind the running work, it would compact against a context that
    // has moved on by the time it runs. The refresh after turn-done sees the
    // same fill and fires then.
    const a = new AutoCompactor();
    expect(a.consider(97, true)).toBe(false);
    expect(a.consider(97, false)).toBe(true);
  });

  it('fires exactly once when the compaction frees nothing', () => {
    // THE LOOP THIS EXISTS TO PREVENT. A thread that is mostly recent turns
    // can come back at 88% — on "pct >= 90" alone the next status frame would
    // compact again, and again, until the conversation was a paragraph.
    const a = new AutoCompactor();
    expect(a.consider(93, false)).toBe(true);
    for (const pct of [93, 91, 90, 97]) expect(a.consider(pct, false), `${pct}%`).toBe(false);
  });

  it('re-arms only after the fill has fallen well back', () => {
    const a = new AutoCompactor();
    expect(a.consider(95, false)).toBe(true);
    expect(a.consider(AUTO_COMPACT_REARM_PCT + 1, false)).toBe(false);
    expect(a.consider(AUTO_COMPACT_REARM_PCT, false)).toBe(false); // the drop itself re-arms
    expect(a.consider(95, false)).toBe(true); // …and the next climb fires
  });

  it('re-arms from a mid-turn reading too, so the gate only delays firing', () => {
    const a = new AutoCompactor();
    expect(a.consider(95, false)).toBe(true);
    expect(a.consider(10, true)).toBe(false);
    expect(a.consider(95, false)).toBe(true);
  });

  it('ignores a missing or nonsense reading', () => {
    const a = new AutoCompactor();
    expect(a.consider(undefined, false)).toBe(false);
    expect(a.consider(Number.NaN, false)).toBe(false);
  });

  it('leaves headroom under the harness ceiling rather than racing it', () => {
    // The harness compacts on its own near ~95%; at that fill a single long
    // agentic turn can cross the rest inside one tool loop and fail the send.
    expect(AUTO_COMPACT_PCT).toBeLessThan(95);
    expect(AUTO_COMPACT_PCT).toBeGreaterThan(AUTO_COMPACT_REARM_PCT);
  });
});
