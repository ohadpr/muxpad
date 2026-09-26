import { describe, expect, it } from 'vitest';
import { buildIdFromEntrySrc, buildIdFromHtml } from './build-id.js';

/**
 * The identifier both sides compare. The tests that matter most are the ones
 * asserting NULL: a null makes the update check inert, and every environment
 * that cannot honestly name a build has to land there rather than on a string
 * that compares unequal forever.
 */
describe('buildIdFromEntrySrc', () => {
  it('names the entry chunk from the attribute as authored', () => {
    expect(buildIdFromEntrySrc('/assets/index-Cgp7p3nE.js')).toBe('index-Cgp7p3nE.js');
  });

  it('names the same chunk from a fully-resolved absolute URL', () => {
    // What the DOM's `.src` property hands back, as opposed to getAttribute().
    expect(buildIdFromEntrySrc('https://muxpad.ts.net/assets/index-Cgp7p3nE.js')).toBe(
      'index-Cgp7p3nE.js',
    );
  });

  it('is null for the dev server shell', () => {
    // The whole reason the /assets/ test exists: `/src/main.tsx` is a STABLE
    // name, so comparing it against the server's hashed dist/ shell would
    // prompt "new version" on every visibility flip during development.
    expect(buildIdFromEntrySrc('/src/main.tsx')).toBeNull();
  });

  it('is null for anything outside the hashed asset root', () => {
    expect(buildIdFromEntrySrc('/sw.js')).toBeNull();
    expect(buildIdFromEntrySrc('https://cdn.example.com/lib.js')).toBeNull();
  });

  it('is null for a missing or empty src', () => {
    expect(buildIdFromEntrySrc(null)).toBeNull();
    expect(buildIdFromEntrySrc(undefined)).toBeNull();
    expect(buildIdFromEntrySrc('')).toBeNull();
  });

  it('is null for a directory-looking src with no filename', () => {
    expect(buildIdFromEntrySrc('/assets/')).toBeNull();
  });

  it('drops query and fragment — they are not part of the build identity', () => {
    expect(buildIdFromEntrySrc('/assets/index-Cgp7p3nE.js?t=1')).toBe('index-Cgp7p3nE.js');
    expect(buildIdFromEntrySrc('/assets/index-Cgp7p3nE.js#x')).toBe('index-Cgp7p3nE.js');
  });
});

describe('buildIdFromHtml', () => {
  const shell = (src: string) =>
    `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest" /></head><body><div id="root"></div><script type="module" crossorigin src="${src}"></script></body></html>`;

  it('finds the entry chunk in a built shell', () => {
    expect(buildIdFromHtml(shell('/assets/index-Cgp7p3nE.js'))).toBe('index-Cgp7p3nE.js');
  });

  it('does not depend on attribute order', () => {
    const html = '<script src="/assets/index-aaaaaaaa.js" type="module" crossorigin></script>';
    expect(buildIdFromHtml(html)).toBe('index-aaaaaaaa.js');
  });

  it('skips scripts that are not bundle entries', () => {
    const html =
      '<script src="/sw.js"></script>' +
      '<script type="module" crossorigin src="/assets/index-bbbbbbbb.js"></script>';
    expect(buildIdFromHtml(html)).toBe('index-bbbbbbbb.js');
  });

  it('is null for the dev shell, which names a source file', () => {
    expect(buildIdFromHtml(shell('/src/main.tsx'))).toBeNull();
  });

  it('is null for a shell with no script at all', () => {
    expect(buildIdFromHtml('<!doctype html><html><body></body></html>')).toBeNull();
  });
});
