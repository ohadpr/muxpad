import { describe, expect, it } from 'vitest';
import {
  GAP_MS,
  TranscriptBuffer,
  looksComplete,
  normalizeUtterance,
  reconstructRequest,
} from './transcript';

const d = (delta: string, start_ms: number, end_ms: number) => ({ delta, start_ms, end_ms });

describe('segmentation — the protocol gives no turn boundaries at all', () => {
  it('joins fragments that arrive back to back', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('run the ', 1000, 1400));
    b.push('input', d('tests', 1400, 1800));
    expect(b.segments('input')).toHaveLength(1);
    expect(b.segments('input')[0]?.text).toBe('run the tests');
  });

  it('starts a new utterance after a silence longer than the gap', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('run the tests', 1000, 1800));
    b.push('input', d('actually never mind', 1800 + GAP_MS + 1, 4000));
    expect(b.segments('input')).toHaveLength(2);
    expect(b.segments('input')[1]?.text).toBe('actually never mind');
  });

  it('keeps one utterance across a pause shorter than the gap', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('run the tests', 1000, 1800));
    b.push('input', d(' and push', 1800 + GAP_MS - 100, 3000));
    expect(b.segments('input')).toHaveLength(1);
  });

  it('treats an overlapping (revised) delta as a continuation, never as new silence', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('hello', 1000, 2000));
    b.push('input', d(' there', 1500, 2500));
    expect(b.segments('input')).toHaveLength(1);
    expect(b.open('input')?.endMs).toBe(2500);
  });

  it('never lets a revision drag the end time backwards', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('hello', 1000, 3000));
    b.push('input', d('!', 1100, 1200));
    expect(b.open('input')?.endMs).toBe(3000);
  });

  it('keeps the two channels apart', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('user said this', 0, 500));
    b.push('output', d('model said this', 0, 500));
    expect(b.segments('input')).toHaveLength(1);
    expect(b.segments('output')[0]?.text).toBe('model said this');
  });

  it('survives missing timestamps rather than producing NaN segments', () => {
    const b = new TranscriptBuffer();
    b.push('input', { delta: 'x', start_ms: Number.NaN, end_ms: Number.NaN });
    const seg = b.open('input');
    expect(Number.isFinite(seg?.startMs)).toBe(true);
    expect(Number.isFinite(seg?.endMs)).toBe(true);
  });
});

describe('segmentAt — joining a delegation to the speech that caused it', () => {
  const build = () => {
    const b = new TranscriptBuffer();
    b.push('input', d('first thing', 0, 1000));
    b.push('input', d('second thing', 5000, 6000));
    return b;
  };

  it('prefers the utterance containing the offset', () => {
    expect(build().segmentAt('input', 5500)?.text).toBe('second thing');
  });

  it('falls back to the nearest utterance that already ended — the common case', () => {
    // The model delegated a beat after the user stopped talking.
    expect(build().segmentAt('input', 6200)?.text).toBe('second thing');
  });

  it('reaches FORWARD when the delegation beat its own transcript', () => {
    // Documented behaviour: delegation.created can arrive before a complete
    // sentence exists. Nothing precedes the offset, so the utterance that
    // starts just after it is the one meant.
    const b = new TranscriptBuffer();
    b.push('input', d('do the thing', 4000, 5000));
    expect(b.segmentAt('input', 3900)?.text).toBe('do the thing');
  });

  it('is undefined when nothing has been said', () => {
    expect(new TranscriptBuffer().segmentAt('input', 1000)).toBeUndefined();
  });
});

describe('looksComplete', () => {
  it('accepts the punctuation a transcriber actually emits', () => {
    expect(looksComplete('run the tests.')).toBe(true);
    expect(looksComplete('did it work?')).toBe(true);
    expect(looksComplete('stop!')).toBe(true);
    expect(looksComplete('he said "go".')).toBe(true);
    expect(looksComplete('もういい。')).toBe(true);
  });

  it('rejects a sentence still being spoken', () => {
    expect(looksComplete('run the tests and then')).toBe(false);
    expect(looksComplete('')).toBe(false);
  });
});

describe('normalizeUtterance', () => {
  it('collapses the doubled spaces that delta seams produce', () => {
    expect(normalizeUtterance('  run   the \n tests  ')).toBe('run the tests');
  });
});

describe('reconstructRequest', () => {
  it('rebuilds the user utterance the delegation refers to', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('can you ', 1000, 1400));
    b.push('input', d('run the tests?', 1400, 2000));
    const r = reconstructRequest(b, { offsetMs: 2100 });
    expect(r.text).toBe('can you run the tests?');
    expect(r.complete).toBe(true);
  });

  it('reports an unfinished sentence as incomplete, so the caller can wait', () => {
    const b = new TranscriptBuffer();
    b.push('input', d('can you run the', 1000, 1600));
    const r = reconstructRequest(b, { offsetMs: 1500 });
    expect(r.complete).toBe(false);
    expect(r.text).toBe('can you run the');
  });

  it('returns empty text when there is nothing to reconstruct', () => {
    const r = reconstructRequest(new TranscriptBuffer(), { offsetMs: 1000 });
    expect(r.text).toBe('');
    expect(r.utterance).toBeUndefined();
  });

  it('carries the model’s last line as context — without it "yeah, do it" is unanswerable', () => {
    const b = new TranscriptBuffer();
    b.push('output', d('Want me to run the test suite?', 0, 2000));
    b.push('input', d('yeah, do it.', 3000, 3800));
    const r = reconstructRequest(b, { offsetMs: 3900, withContext: true });
    expect(r.text).toContain('Want me to run the test suite?');
    expect(r.text).toContain('yeah, do it.');
    // The user's words are last, so the agent reads them as the instruction.
    expect(r.text.indexOf('yeah, do it.')).toBeGreaterThan(
      r.text.indexOf('Want me to run the test suite?'),
    );
  });

  it('omits context when there is none in the window', () => {
    const b = new TranscriptBuffer();
    b.push('output', d('ancient history', 0, 100));
    b.push('input', d('run the tests.', 500_000, 500_800));
    const r = reconstructRequest(b, { offsetMs: 500_900, withContext: true });
    expect(r.text).toBe('run the tests.');
  });

  it('omits context when not asked for it', () => {
    const b = new TranscriptBuffer();
    b.push('output', d('Want me to run it?', 0, 2000));
    b.push('input', d('yes.', 3000, 3400));
    expect(reconstructRequest(b, { offsetMs: 3500 }).text).toBe('yes.');
  });
});
