import { describe, expect, it } from 'vitest';
import { MAX_UTTERANCE_MS, SILENCE_CUT_MS, Segmenter, meterLevel, rmsOf } from './segment';

/** Feed an envelope: [levelDuringMs, rms] pairs, sampled every `stepMs`. */
function run(
  seg: Segmenter,
  envelope: Array<[number, number]>,
  stepMs = 50,
): { events: ReturnType<Segmenter['feed']>[]; endedAt: number } {
  const events: ReturnType<Segmenter['feed']>[] = [];
  let t = 0;
  for (const [durMs, rms] of envelope) {
    for (let d = 0; d < durMs; d += stepMs) {
      const e = seg.feed(t, rms);
      if (e) events.push(e);
      t += stepMs;
    }
  }
  return { events, endedAt: t };
}

const LOUD = 0.08;
const ROOM = 0.002;

describe('Segmenter', () => {
  it('cuts one utterance out of silence·speech·silence', () => {
    const { events } = run(new Segmenter(), [
      [1000, ROOM],
      [2000, LOUD],
      [1500, ROOM],
    ]);
    expect(events.map((e) => e?.type)).toEqual(['start', 'end']);
    const end = events[1] as { startMs: number; endMs: number };
    // Started at the first loud sample (minus the lead), ended a tail past the
    // last one — not at the moment the cut was DETECTED, which is 700ms later.
    expect(end.startMs).toBeGreaterThanOrEqual(800);
    expect(end.startMs).toBeLessThanOrEqual(1000);
    expect(end.endMs).toBeGreaterThanOrEqual(2900);
    expect(end.endMs).toBeLessThanOrEqual(3200);
  });

  it('does not cut on a plosive gap — that is what hysteresis is for', () => {
    // A dip below the START threshold but above the SILENCE one, for well
    // under the cut: one utterance, not two.
    const { events } = run(new Segmenter(), [
      [500, ROOM],
      [800, LOUD],
      [200, 0.01],
      [800, LOUD],
      [1200, ROOM],
    ]);
    expect(events.filter((e) => e?.type === 'end')).toHaveLength(1);
    expect(events.filter((e) => e?.type === 'start')).toHaveLength(1);
  });

  it('cuts twice when the gap is a real pause', () => {
    const { events } = run(new Segmenter(), [
      [300, ROOM],
      [900, LOUD],
      [SILENCE_CUT_MS + 300, ROOM],
      [900, LOUD],
      [SILENCE_CUT_MS + 300, ROOM],
    ]);
    expect(events.filter((e) => e?.type === 'end')).toHaveLength(2);
    expect(events.filter((e) => e?.type === 'start')).toHaveLength(2);
  });

  it('drops a click rather than paying to transcribe a chair', () => {
    const { events } = run(new Segmenter(), [
      [200, ROOM],
      [100, LOUD],
      [1200, ROOM],
    ]);
    expect(events.map((e) => e?.type)).toEqual(['start', 'drop']);
  });

  it('breaks a monologue at the ceiling and keeps going', () => {
    const { events } = run(
      new Segmenter(),
      [
        [200, ROOM],
        [MAX_UTTERANCE_MS + 4000, LOUD],
        [1200, ROOM],
      ],
      100,
    );
    const ends = events.filter(
      (e): e is { type: 'end'; startMs: number; endMs: number; continues: boolean } =>
        e?.type === 'end',
    );
    expect(ends.length).toBeGreaterThanOrEqual(2);
    expect(ends[0]?.continues).toBe(true);
    expect(ends[ends.length - 1]?.continues).toBe(false);
    // The next clip starts where the last one ended: no second of speech is
    // dropped on the floor at a ceiling cut.
    expect(ends[1]?.startMs).toBe(ends[0]?.endMs);
  });

  it('flush closes a review stopped mid-sentence', () => {
    const seg = new Segmenter();
    const { endedAt } = run(seg, [
      [300, ROOM],
      [1500, LOUD],
    ]);
    expect(seg.speaking).toBe(true);
    const e = seg.flush(endedAt);
    expect(e?.type).toBe('end');
    expect(seg.speaking).toBe(false);
    expect(seg.flush(endedAt + 100)).toBeNull();
  });

  it('reports speaking, which is what the frame ring keys dedupe off', () => {
    const seg = new Segmenter();
    expect(seg.speaking).toBe(false);
    seg.feed(0, LOUD);
    expect(seg.speaking).toBe(true);
  });
});

describe('levels', () => {
  it('rmsOf is the plain root mean square', () => {
    expect(rmsOf([1, -1, 1, -1])).toBeCloseTo(1);
    expect(rmsOf([0, 0])).toBe(0);
    expect(rmsOf([])).toBe(0);
  });

  it('meterLevel puts speech in the middle of the bar, not at the bottom', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    // Room tone reads near empty, ordinary speech reads clearly lit — the
    // whole point of a meter you can trust at a glance.
    expect(meterLevel(0.002)).toBeLessThan(0.3);
    expect(meterLevel(0.08)).toBeGreaterThan(0.5);
  });
});
