import { describe, expect, it } from 'vitest';
import { uploadError } from './upload-error';

describe('what a failed upload says', () => {
  it('digs the sentence out of the server envelope', () => {
    // This is the shape `api.uploadAttachment` throws: the whole response
    // body. Printing `error.message` put the JSON in front of the user.
    const thrown = new Error(
      JSON.stringify({
        error: { code: 'too_large', message: 'clip.mov is 812 MB — the limit is 512 MB' },
      }),
    );
    expect(uploadError(thrown)).toBe('clip.mov is 812 MB — the limit is 512 MB');
  });

  it('keeps plain text as it is', () => {
    expect(uploadError(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });

  it('never returns nothing', () => {
    // A composer line reading "upload failed: " is worse than one reason.
    for (const bad of [new Error(''), undefined, null, {}]) {
      expect(uploadError(bad).length).toBeGreaterThan(0);
    }
  });

  it('takes the first line of a proxy error page and caps it', () => {
    const html = `<html>\n${'x'.repeat(500)}`;
    expect(uploadError(new Error(html))).toBe('<html>');
    expect(uploadError(new Error('y'.repeat(500))).length).toBeLessThanOrEqual(200);
  });

  it('falls back to the raw text when the body is JSON but not the envelope', () => {
    expect(uploadError(new Error('{"nope":1}'))).toBe('{"nope":1}');
  });
});
