import { describe, expect, it } from 'vitest';
import { chunkForAppend, estimateTokens } from './chunk';
import { APPEND_TOKEN_CAP } from './protocol';

describe('estimateTokens', () => {
  it('is free for whitespace and ~1 per short word', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n  ')).toBe(0);
    expect(estimateTokens('hi')).toBe(1);
    // 'three' is five characters, so it costs two — the estimator rounds UP
    // per word by design, and this is what that looks like on real prose.
    expect(estimateTokens('one two three')).toBe(4);
  });

  it('charges a token per ~4 characters of a long word', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('charges punctuation and symbols individually — the case a flat 4-chars-per-token gets badly wrong', () => {
    expect(estimateTokens('!!!!')).toBe(4);
    expect(estimateTokens('...')).toBe(3);
    // The realistic version: a dense line of punctuation is nowhere near
    // len/4 tokens, and assuming it is would blow the cap.
    const dense = '{},;:(){},;:(){},;:()';
    expect(estimateTokens(dense)).toBe(dense.length);
    expect(estimateTokens(dense)).toBeGreaterThan(dense.length / 4);
  });

  it('never under-counts plain prose (the direction that matters)', () => {
    const prose = 'The quick brown fox jumps over the lazy dog, repeatedly, at length.';
    // Real tokenizers land near words+punctuation; we must be at or above.
    expect(estimateTokens(prose)).toBeGreaterThanOrEqual(prose.split(/\s+/).length);
  });
});

describe('chunkForAppend', () => {
  it('returns nothing at all for empty or whitespace input', () => {
    expect(chunkForAppend('')).toEqual([]);
    expect(chunkForAppend('   \n\t ')).toEqual([]);
  });

  it('leaves a short append as one trimmed piece', () => {
    expect(chunkForAppend('  All done.  ')).toEqual(['All done.']);
  });

  it('EVERY chunk respects the 500-token cap', () => {
    const sentence = 'The agent finished editing the router and the tests are green. ';
    const long = sentence.repeat(400);
    expect(estimateTokens(long)).toBeGreaterThan(APPEND_TOKEN_CAP * 5);
    const chunks = chunkForAppend(long);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(APPEND_TOKEN_CAP);
  });

  it('loses no words', () => {
    const long = 'alpha beta gamma delta epsilon. '.repeat(300);
    const rejoined = chunkForAppend(long).join(' ');
    expect(rejoined.split(/\s+/).filter(Boolean)).toEqual(long.split(/\s+/).filter(Boolean));
  });

  it('prefers sentence boundaries — chunks end on punctuation when they can', () => {
    const text = `${'This is a whole sentence about the repository. '.repeat(120)}`;
    const chunks = chunkForAppend(text);
    expect(chunks.length).toBeGreaterThan(1);
    // All but possibly the last should close on a full stop.
    for (const c of chunks.slice(0, -1)) expect(c.endsWith('.')).toBe(true);
  });

  it('falls back to word boundaries inside a sentence too long to keep whole', () => {
    const oneSentence = `${'word '.repeat(2000)}end.`;
    const chunks = chunkForAppend(oneSentence);
    for (const c of chunks) {
      expect(estimateTokens(c)).toBeLessThanOrEqual(APPEND_TOKEN_CAP);
      // No word was cut in half.
      expect(/^((word|end\.)\s*)+$/.test(c)).toBe(true);
    }
  });

  it('hard-splits a single unbreakable run, and re-measures rather than assuming 4 chars per token', () => {
    // Punctuation-dense: 4000 chars is 4000 tokens, so a naive chars*4 split
    // would emit 2000-token chunks.
    const blob = ';'.repeat(4000);
    const chunks = chunkForAppend(blob);
    expect(chunks.length).toBeGreaterThanOrEqual(8);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(APPEND_TOKEN_CAP);
    expect(chunks.join('').length).toBe(4000);
  });

  it('honours a custom cap', () => {
    const chunks = chunkForAppend('one two three four five six seven eight nine ten.', 3);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(3);
  });

  it('terminates on pathological input instead of spinning', () => {
    const chunks = chunkForAppend('x'.repeat(100), 1);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('').length).toBe(100);
  });
});
