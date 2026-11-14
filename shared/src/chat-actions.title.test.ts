import { describe, expect, it } from 'vitest';
import { titleForState } from './chat-actions.js';

describe('titleForState', () => {
  it('does not claim a failed act happened', () => {
    // The reported card, verbatim: "Downloaded an email attachment" in bold
    // with a small grey FAILED beside it. The loudest element was the lie.
    expect(titleForState('Downloaded an email attachment', 'failed')).toBe(
      'Tried to download an email attachment',
    );
  });

  it('says a declined act was never tried, not that it was tried and failed', () => {
    expect(titleForState('Posted to #eng', 'declined')).toBe('Did not post to #eng');
  });

  it('leaves a successful or waiting card exactly as the producer wrote it', () => {
    for (const state of ['sent', 'pending'] as const)
      expect(titleForState('Posted to #eng', state)).toBe('Posted to #eng');
  });

  it('leaves a verb it does not know alone rather than mangling the sentence', () => {
    expect(titleForState('Frobnicated the widget', 'failed')).toBe('Frobnicated the widget');
    expect(titleForState('', 'failed')).toBe('');
  });

  it('covers every verb the producers actually start a title with', async () => {
    // The guard against a new card type quietly landing in the fallback: the
    // same failure mode as publish wearing the "unknown integration" arrow.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../server/src/slack-actions.ts', import.meta.url), 'utf8');
    const verbs = [...src.matchAll(/=> ?`([A-Z][a-z]+) /g)].map((m) => m[1]);
    expect(verbs.length).toBeGreaterThan(10);
    for (const v of new Set(verbs))
      expect(titleForState(`${v} a thing`, 'failed'), v).toMatch(/^Tried to /);
  });
});
