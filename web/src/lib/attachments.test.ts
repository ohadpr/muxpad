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

  /**
   * ── A PATH IN A CODE BLOCK IS NOT AN ATTACHMENT ──────────────────────────
   * Reported as "something got garbled up", with a screenshot: a message that
   * SHOWED the attachment-message format inside a fence had its example paths
   * pulled out and drawn as broken images — and, worse, the fence was cut into
   * pieces, so its ``` markers stopped pairing and the whole rest of the
   * message rendered as one code block.
   */
  it('leaves a fenced example alone — paths AND fence intact', () => {
    const text = ['here is the shape:', '```', `① a note`, A, `② another`, B, '```', 'after'].join(
      '\n',
    );
    const parts = splitMessageAttachments(text);
    expect(parts.map((p) => p.kind)).toEqual(['text']);
    // The fence survives whole, which is the half that broke the message.
    const only = parts[0] as { kind: 'text'; text: string };
    expect(only.text.match(/```/g)).toHaveLength(2);
    expect(only.text).toContain(A);
    expect(only.text.endsWith('after')).toBe(true);
  });

  it('leaves an inline span alone', () => {
    expect(mediaCount(`write \`${A}\` into the draft`)).toBe(0);
  });

  it('still renders a real reference in the same message as an example', () => {
    // The common case for an agent explaining its own output: a fenced sample
    // AND an actual attachment it is showing you.
    const text = ['```', A, '```', '', `and here is the real one: ${B}`].join('\n');
    const parts = splitMessageAttachments(text);
    expect(parts.filter((p) => p.kind === 'media')).toHaveLength(1);
    expect((parts.find((p) => p.kind === 'media') as { name: string }).name).toBe('11223344.jpg');
  });

  it('treats an unterminated fence as code to the end — a streaming message', () => {
    expect(mediaCount(['```', A].join('\n'))).toBe(0);
  });

  it('does not let a lone backtick inside a fence swallow a later reference', () => {
    // A shell example containing one backtick used to open an inline span that
    // ran to the end of the message.
    const text = ['```sh', 'echo `date`', '```', '', `shot: ${A}`].join('\n');
    expect(mediaCount(text)).toBe(1);
  });
});
