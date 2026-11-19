import { describe, expect, it } from 'vitest';
import { BROWSER_APP_SLUG_PREFIX, isBrowserAppSlug } from './browser-app-slug.js';

/**
 * Tested HERE, in shared, and that is not arbitrary: the web package resolves
 * `@muxpad/shared` to the BUILT dist, so a change to this rule is invisible to
 * a web test until shared is rebuilt. Found the hard way — a sabotage of this
 * very function left the web suite green.
 */
describe('isBrowserAppSlug', () => {
  it('claims the rows muxpad mints for its own browsers', () => {
    expect(isBrowserAppSlug('browser-default')).toBe(true);
    expect(isBrowserAppSlug('browser-perf-chat-open')).toBe(true);
    expect(isBrowserAppSlug(`${BROWSER_APP_SLUG_PREFIX}x`)).toBe(true);
  });

  it('does NOT claim an app the user happens to call browser', () => {
    // The prefix alone is not the rule — `browser-` AND something after it is.
    // A false positive here hides somebody's own app from their own search.
    expect(isBrowserAppSlug('browser')).toBe(false);
    expect(isBrowserAppSlug('browser-')).toBe(false);
    expect(isBrowserAppSlug('browsers')).toBe(false);
    expect(isBrowserAppSlug('my-browser-notes')).toBe(false);
  });

  it('is the prefix the server actually mints with', () => {
    expect(BROWSER_APP_SLUG_PREFIX).toBe('browser-');
  });
});
