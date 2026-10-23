import { describe, expect, it } from 'vitest';
import { type ReviewNote, composeReviewMessage, noteMark } from './review.js';

const note = (text: string, frames: string[] = [], at = 0): ReviewNote => ({
  id: `n${at}`,
  text,
  startMs: at,
  endMs: at + 1000,
  frames,
});

describe('composeReviewMessage', () => {
  it('numbers several notes and puts each frame under its own instruction', () => {
    const msg = composeReviewMessage([
      note('this video should be smaller', ['/d/attachments/a1.jpg'], 0),
      note('this button make it pink', ['/d/attachments/b2.jpg'], 4000),
    ]);
    expect(msg).toBe(
      [
        'From a screen review — 2 things:',
        '',
        '① this video should be smaller',
        '/d/attachments/a1.jpg',
        '',
        '② this button make it pink',
        '/d/attachments/b2.jpg',
      ].join('\n'),
    );
  });

  it('does not number a single note — there is nothing to count', () => {
    expect(composeReviewMessage([note('make the font bigger', ['/d/attachments/a1.jpg'])])).toBe(
      'From a screen review:\n\nmake the font bigger\n/d/attachments/a1.jpg',
    );
  });

  it('keeps a note whose capture failed — the words still carry the ask', () => {
    expect(composeReviewMessage([note('make the font bigger')])).toContain('make the font bigger');
  });

  it('carries several frames for one wandering sentence', () => {
    const msg = composeReviewMessage([
      note('these two buttons, combine them', ['/d/attachments/a.jpg', '/d/attachments/b.jpg']),
    ]);
    expect(msg.split('\n').slice(-2)).toEqual(['/d/attachments/a.jpg', '/d/attachments/b.jpg']);
  });

  it('drops scrapped and empty notes', () => {
    expect(composeReviewMessage([note('   ')])).toBe('');
    expect(composeReviewMessage([])).toBe('');
  });
});

describe('noteMark', () => {
  it('uses circled digits while they exist and plain numbers after', () => {
    expect(noteMark(0)).toBe('①');
    expect(noteMark(19)).toBe('⑳');
    expect(noteMark(20)).toBe('21.');
  });
});
