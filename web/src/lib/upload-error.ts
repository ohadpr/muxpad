/**
 * THE SENTENCE A FAILED UPLOAD SHOULD SHOW.
 *
 * `api.uploadAttachment` throws `new Error(await res.text())`, and the body is
 * the server's JSON envelope — so a composer that printed `error.message` put
 * `{"error":{"code":"too_large","message":"clip.mov is 812 MB — the limit is
 * 512 MB"}}` in front of the user. The sentence inside it is the one the
 * server wrote to be read; this digs it out and leaves everything else alone.
 *
 * Every branch ends in something printable. A failed upload is already a bad
 * moment; "undefined" is a worse one.
 */
export function uploadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw.trim();
  if (!text) return 'the server gave no reason';
  if (text.startsWith('{')) {
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } };
      const message = body.error?.message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    } catch {
      /* not the envelope after all — fall through to the raw text */
    }
  }
  // A proxy or a dropped connection produces an HTML page or a network error
  // instead. Those are long and nobody reads them past the first line.
  const first = text.split('\n')[0] ?? text;
  return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}
