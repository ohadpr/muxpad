import type { ReviewNote } from '@muxpad/shared';
import { composeReviewMessage } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { splitMessageAttachments } from '../attachments';

/**
 * THE ROUND TRIP: what a review composes must come back out of the chat
 * renderer as the same instructions with the same pictures under them.
 *
 * This is the seam where the feature could break without either side being
 * wrong. `composeReviewMessage` lives in shared (the server may compose one
 * day); `splitMessageAttachments` is the chat's renderer. Nothing else pins
 * them together — and the code-fence bug (fixed 2026-10-22) is the proof that
 * this parser has edges: a path inside backticks is text ABOUT a path, and a
 * review note can easily contain one, because people say "the thing in
 * attachments" while pointing at it.
 */

const note = (text: string, frames: string[], at = 0): ReviewNote => ({
  id: `n${at}`,
  text,
  startMs: at,
  endMs: at + 1000,
  frames,
});

const kinds = (msg: string) => splitMessageAttachments(msg).map((p) => p.kind);
const media = (msg: string) =>
  splitMessageAttachments(msg)
    .filter((p) => p.kind === 'media')
    .map((p) => (p as { name: string }).name);

describe('a composed review, read back by the chat renderer', () => {
  it('interleaves each instruction with its own frame, in order', () => {
    const msg = composeReviewMessage([
      note('this video should be smaller', ['/d/attachments/a1.jpg'], 0),
      note('this button make it pink', ['/d/attachments/b2.jpg'], 4000),
      note('these two buttons, combine them', ['/d/attachments/c3.jpg'], 9000),
    ]);
    // text, image, text, image, text, image — the shape the reader sees.
    expect(kinds(msg)).toEqual(['text', 'media', 'text', 'media', 'text', 'media']);
    expect(media(msg)).toEqual(['a1.jpg', 'b2.jpg', 'c3.jpg']);
  });

  it('keeps several frames adjacent for one wandering sentence', () => {
    const msg = composeReviewMessage([
      note('all of this column is too tight', ['/d/attachments/a.jpg', '/d/attachments/b.jpg']),
    ]);
    expect(media(msg)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('survives an instruction that MENTIONS a path in backticks', () => {
    // "the thing in `/x/attachments/old.jpg` should go" — the renderer must
    // leave that as text and still render the note's own frame as an image. A
    // regression here cut the fence in two and swallowed the rest of a message.
    const msg = composeReviewMessage([
      note('replace `/x/attachments/old.jpg` with the new one', ['/d/attachments/new.jpg']),
    ]);
    expect(media(msg)).toEqual(['new.jpg']);
  });

  it('renders a note whose capture failed as plain text', () => {
    const msg = composeReviewMessage([note('make the font bigger', [])]);
    expect(kinds(msg)).toEqual(['text']);
    expect(msg).toContain('make the font bigger');
  });

  it('numbers the notes so an agent can answer them one by one', () => {
    const msg = composeReviewMessage([
      note('first thing', ['/d/attachments/a.jpg']),
      note('second thing', ['/d/attachments/b.jpg']),
    ]);
    expect(msg).toContain('① first thing');
    expect(msg).toContain('② second thing');
  });
});
