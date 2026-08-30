import { describe, expect, it } from 'vitest';
import { composeOutgoingMessage, splitMessageAttachments } from './attachments';

const A = '/Users/me/.muxpad/attachments/aabbccdd.png';
const B = '/Users/me/.muxpad/attachments/11223344.jpg';

/** How many images the transcript would render for a message. */
function mediaCount(text: string): number {
  return splitMessageAttachments(text).filter((p) => p.kind === 'media').length;
}

describe('composeOutgoingMessage', () => {
  it('appends attachment paths after the prose', () => {
    expect(composeOutgoingMessage('look at this', [A])).toBe(`look at this ${A}`);
  });

  it('sends attachments with no prose', () => {
    expect(composeOutgoingMessage('', [A, B])).toBe(`${A} ${B}`);
  });

  it('one attached image renders exactly one thumbnail', () => {
    const out = composeOutgoingMessage('look at this', [A]);
    expect(out.split(A).length - 1).toBe(1); // exactly one reference
    expect(mediaCount(out)).toBe(1);
  });

  // The regression: the photo picker used to splice the uploaded path into the
  // draft AND leave a chip, so send appended the same path a second time and
  // the bubble drew the image twice.
  it('does not re-append a path the draft already references', () => {
    const draft = `${A}\n\nwhat is this?`;
    const out = composeOutgoingMessage(draft, [A]);
    expect(out.split(A).length - 1).toBe(1);
    expect(mediaCount(out)).toBe(1);
  });

  it('appends only the attachments the draft is missing', () => {
    const out = composeOutgoingMessage(`${A} and`, [A, B]);
    expect(out).toBe(`${A} and ${B}`);
    expect(mediaCount(out)).toBe(2);
  });

  it('drops duplicate paths within the attachment list itself', () => {
    expect(mediaCount(composeOutgoingMessage('hi', [A, A]))).toBe(1);
  });

  it('trims the prose and stays empty for an empty send', () => {
    expect(composeOutgoingMessage('  hey  ', [])).toBe('hey');
    expect(composeOutgoingMessage('   ', [])).toBe('');
  });
});

describe('splitMessageAttachments', () => {
  it('keeps the prose around a reference', () => {
    const parts = splitMessageAttachments(`before ${A} after`);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'media', 'text']);
  });
});
