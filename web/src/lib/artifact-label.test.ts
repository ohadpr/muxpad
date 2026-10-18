import { describe, expect, it } from 'vitest';
import { artifactLabel } from './artifact-label';

describe('a link on a card reads as words', () => {
  it('turns a published slug into the words it is made of', () => {
    expect(artifactLabel('https://pub.example.org/trayo-plan-card-demo/')).toBe(
      'trayo plan card demo',
    );
  });

  it('keeps a FILENAME a filename — a dot means you would search for it', () => {
    expect(artifactLabel('https://example.com/reports/q3-summary.md')).toBe('q3-summary.md');
    expect(artifactLabel('/tmp/todos.md')).toBe('todos.md');
    expect(artifactLabel('~/Desktop/notes/plan.html')).toBe('plan.html');
  });

  it('walks left when the last segment identifies nothing', () => {
    // "43" is not a label. The segment before it is what makes it a thing.
    expect(artifactLabel('https://github.com/ohadpr/muxpad/pull/43')).toBe('pull / 43');
    expect(artifactLabel('https://example.com/docs/api/v2')).toBe('api / v2');
    // …but only ONE step. Three segments is a path again, which is the thing
    // this function exists not to show.
    expect(artifactLabel('https://example.com/a/b/v2')).toBe('b / v2');
  });

  it('falls back to the host when there is no path at all', () => {
    expect(artifactLabel('https://news.ycombinator.com/')).toBe('news.ycombinator.com');
    expect(artifactLabel('https://www.example.com')).toBe('example.com');
  });

  it('decodes percent-escapes rather than showing them', () => {
    expect(artifactLabel('https://example.com/my%20report')).toBe('my report');
  });

  it('never returns an empty label', () => {
    // Whatever goes wrong, the card must say SOMETHING pressable — a blank link
    // is worse than the url it replaced.
    for (const a of ['', 'not a url', 'https://', '/', 'https://example.com//']) {
      expect(artifactLabel(a).length).toBeGreaterThan(0);
    }
  });
});
