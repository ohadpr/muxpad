import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKING_VARIANTS, __resetWorkingVariant, workingVariantFor } from './working-variant';

/**
 * TEN INDICATORS, ONE PER TURN.
 *
 * A single indicator becomes furniture within a day and stops being read; a
 * thing that changed since last time gets a glance, which is the whole job of
 * the element. These pin the two properties that make the rotation feel
 * deliberate rather than glitchy.
 */
beforeEach(() => {
  localStorage.clear();
  __resetWorkingVariant();
});
afterEach(() => {
  localStorage.clear();
});

describe('which indicator you get', () => {
  it('shows all ten before repeating any', () => {
    // A uniform random draw would show ~6.5 of the ten over ten turns and hand
    // you the same one twice in a row about one turn in ten, which reads as
    // broken rather than varied. A cycle costs one integer.
    const got = Array.from({ length: WORKING_VARIANTS.length }, (_, i) =>
      workingVariantFor(`turn-${i}`),
    );
    expect(new Set(got).size).toBe(WORKING_VARIANTS.length);
  });

  it('never changes inside one turn, however often it is asked', () => {
    // The indicator unmounts the instant the first token streams and remounts
    // if the stream clears. Advancing on mount would re-roll mid-turn — the one
    // moment anybody is looking at it.
    const a = workingVariantFor('turn-x');
    workingVariantFor('turn-y');
    workingVariantFor('turn-z');
    expect(workingVariantFor('turn-x')).toBe(a);
  });

  it('advances between turns', () => {
    expect(workingVariantFor('t1')).not.toBe(workingVariantFor('t2'));
  });

  it('survives a reload instead of restarting at the first one', () => {
    // Otherwise you get `braille` every morning, which is the fixed indicator
    // this replaced wearing a costume.
    workingVariantFor('t1');
    workingVariantFor('t2');
    const before = workingVariantFor('t3');
    __resetWorkingVariantKeepingStorage();
    expect(workingVariantFor('t3-again')).not.toBe(WORKING_VARIANTS[0]);
    expect(before).toBe(WORKING_VARIANTS[2]);
  });

  it('does not burn a variant on the beat before a turn is identified', () => {
    // Between a send and its transcript line landing there is no turn id. That
    // must read the cursor WITHOUT advancing, or the real turn a moment later
    // skips one and the cycle quietly shows nine of the ten.
    const peek = workingVariantFor(null);
    expect(workingVariantFor('the-real-turn')).toBe(peek);
  });

  it('does not grow without bound on a long-lived pane', () => {
    // A once-a-minute cron in a pane left open for days would otherwise add one
    // entry per fire, forever.
    for (let i = 0; i < 400; i++) workingVariantFor(`fire-${i}`);
    // Still answering, and still cycling — the trim must not break either.
    const run = Array.from({ length: 10 }, (_, i) => workingVariantFor(`late-${i}`));
    expect(new Set(run).size).toBe(10);
  });
});

/** Simulates a page load: the module forgets its turn map, storage persists. */
function __resetWorkingVariantKeepingStorage() {
  const saved = localStorage.getItem('muxpad.workingVariant.v1');
  __resetWorkingVariant();
  if (saved !== null) localStorage.setItem('muxpad.workingVariant.v1', saved);
}
