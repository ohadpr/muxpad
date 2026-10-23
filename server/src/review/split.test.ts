import { describe, expect, it } from 'vitest';
import {
  MAX_SPLITS,
  assignFrames,
  buildSplitPrompt,
  parseSplitReply,
  worthSplitting,
} from './split.js';

/** The real thing, from the spike's successful run: four asks, one breath. */
const FOUR_ASKS =
  'this video should be smaller this button make it Pink and these two buttons combine them together with little icons and the thyroid script should be full with';

describe('parseSplitReply', () => {
  it('takes one instruction per line', () => {
    const reply = [
      'this video should be smaller',
      'this button make it Pink',
      'these two buttons combine them together with little icons',
      'the thyroid script should be full with',
    ].join('\n');
    expect(parseSplitReply(reply, FOUR_ASKS).map((s) => s.text)).toEqual([
      'this video should be smaller',
      'this button make it Pink',
      'these two buttons combine them together with little icons',
      'the thyroid script should be full with',
    ]);
  });

  it('strips the numbering a model adds after being told not to', () => {
    const reply = '1. this video should be smaller\n2) this button make it Pink';
    expect(parseSplitReply(reply, FOUR_ASKS)).toHaveLength(2);
    expect(parseSplitReply(reply, FOUR_ASKS)[0]?.text).toBe('this video should be smaller');
  });

  it('leaves a mishearing alone — the agent repairs that from the picture', () => {
    const got = parseSplitReply('the thyroid script should be full with', FOUR_ASKS);
    expect(got[0]?.text).toContain('thyroid script');
  });

  it('refuses a reply that TIDIED the instruction', () => {
    // Plausible, helpful, and not what the user said — the one error that
    // survives review, because it reads fine in the panel.
    const reply = 'Reduce the size of the video player element\nChange the button colour to pink';
    expect(parseSplitReply(reply, FOUR_ASKS).map((s) => s.text)).toEqual([FOUR_ASKS]);
  });

  it('refuses a reply that explains itself', () => {
    const reply = `Here are the instructions I found:\n${FOUR_ASKS}`;
    expect(parseSplitReply(reply, FOUR_ASKS).map((s) => s.text)).toEqual([FOUR_ASKS]);
  });

  it('refuses an implausible number of splits', () => {
    const reply = Array.from({ length: MAX_SPLITS + 1 }, () => 'this video should be smaller').join(
      '\n',
    );
    expect(parseSplitReply(reply, FOUR_ASKS)).toHaveLength(1);
  });

  it('falls back to the whole remark on an empty reply', () => {
    expect(parseSplitReply('', FOUR_ASKS).map((s) => s.text)).toEqual([FOUR_ASKS]);
    expect(parseSplitReply('\n\n  \n', FOUR_ASKS)).toHaveLength(1);
  });

  it('passes a single instruction through unchanged', () => {
    const one = 'make the font bigger on this page please';
    expect(parseSplitReply(one, one).map((s) => s.text)).toEqual([one]);
  });
});

describe('worthSplitting', () => {
  it('skips the model call for a short remark', () => {
    expect(worthSplitting('make this bigger')).toBe(false);
    expect(worthSplitting(FOUR_ASKS)).toBe(true);
  });
});

describe('assignFrames', () => {
  it('spreads instructions across the frames in spoken order', () => {
    const splits = [
      { text: 'aaaa', frame: null },
      { text: 'bbbb', frame: null },
      { text: 'cccc', frame: null },
      { text: 'dddd', frame: null },
    ];
    const got = assignFrames(splits, 4).map((s) => s.frame);
    expect(got).toEqual([0, 1, 2, 3]);
  });

  it('weights by how long each instruction took to say', () => {
    const got = assignFrames(
      [
        { text: 'a'.repeat(90), frame: null },
        { text: 'b'.repeat(10), frame: null },
      ],
      4,
    ).map((s) => s.frame);
    // The long one was being said for most of the span, so it anchors early;
    // the short one lands at the end.
    expect(got[0]).toBeLessThan(got[1] as number);
    expect(got[1]).toBe(3);
  });

  it('gives a lone instruction ALL the frames', () => {
    expect(assignFrames([{ text: 'one thing', frame: null }], 4)[0]?.frame).toBeNull();
  });

  it('is harmless with one frame or none', () => {
    const splits = [
      { text: 'a', frame: null },
      { text: 'b', frame: null },
    ];
    expect(assignFrames(splits, 1).every((s) => s.frame === null)).toBe(true);
    expect(assignFrames(splits, 0).every((s) => s.frame === null)).toBe(true);
  });

  it('never points past the frames it was given', () => {
    const splits = Array.from({ length: 6 }, (_, i) => ({ text: `x${i}`, frame: null }));
    for (const s of assignFrames(splits, 2)) {
      expect(s.frame).toBeGreaterThanOrEqual(0);
      expect(s.frame).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildSplitPrompt', () => {
  it('carries the remark and the rules', () => {
    const p = buildSplitPrompt(FOUR_ASKS);
    expect(p).toContain(FOUR_ASKS);
    expect(p).toContain('one instruction per line');
    expect(p).toContain('OWN WORDS');
  });
});
