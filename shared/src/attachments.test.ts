import { describe, expect, it } from 'vitest';
import { attachmentPathRe } from './attachments.js';

/**
 * ONE PATTERN, TWO SURFACES.
 *
 * The runner and the web each had a copy that matched a URL as well as a
 * path. They did different damage — the runner edited the link out of the
 * user's message, the web drew it as a broken attachment chip — and fixing
 * one would have left the other. These cases are the contract both now share.
 */
describe('attachmentPathRe', () => {
  const hits = (t: string) => [...t.matchAll(attachmentPathRe())].map((m) => m[0]);

  it('matches a composer-written path, under any data dir', () => {
    expect(hits('look at /Users/o/.muxpad/attachments/08951e42.png')).toEqual([
      '/Users/o/.muxpad/attachments/08951e42.png',
    ]);
    expect(hits('see /tmp/md/attachments/x.png now')).toEqual(['/tmp/md/attachments/x.png']);
  });

  it('does NOT match a URL — the defect this exists for', () => {
    expect(hits('see https://pub.example/attachments/report.pdf for it')).toEqual([]);
    expect(hits('http://host/attachments/x.png')).toEqual([]);
    expect(hits('//host/attachments/x.png')).toEqual([]);
    expect(hits('file:///Users/o/.muxpad/attachments/c.png')).toEqual([]);
  });

  it('stops at the extension, so prose punctuation is not swallowed', () => {
    expect(hits('at /Users/o/.muxpad/attachments/a.png.')).toEqual([
      '/Users/o/.muxpad/attachments/a.png',
    ]);
    expect(hits('(/Users/o/.muxpad/attachments/b.jpg)')).toEqual([
      '/Users/o/.muxpad/attachments/b.jpg',
    ]);
    expect(hits('/Users/o/.muxpad/attachments/x.png.bak')).toEqual([]);
  });

  it('is a fresh RegExp each call, so two callers cannot share lastIndex', () => {
    expect(attachmentPathRe()).not.toBe(attachmentPathRe());
    const a = attachmentPathRe();
    a.exec('/x/attachments/one.png');
    expect(attachmentPathRe().lastIndex).toBe(0);
  });
});
