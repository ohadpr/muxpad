import { describe, expect, it } from 'vitest';
import { cdpCookiesToStorageState } from './CookieJar.js';

/**
 * The shared cookie jar.
 *
 * THE DESIGN THIS SETTLES, after two wrong turns. Agents cannot share one
 * browser: playwright-mcp gives an HTTP client either its own CONTEXT — which a
 * persistent profile refuses, because Chrome locks the profile directory — or a
 * shared context that also shares the PAGE, so two agents clobber each other's
 * navigation. There is no "one jar, a tab each" mode. Proven by a concurrency
 * test, twice, before this file existed.
 *
 * So the jar moves instead of the browser. muxpad's browser is the one a PERSON
 * drives and logs into — the source of truth — and its cookies are exported as a
 * Playwright storage-state that every agent starts warm from, each in its own
 * isolated context. Agents get the logins; nothing contends; the human's session
 * is the thing that accumulates.
 *
 * Measured on the real browser: 324 cookies exported, and two concurrent agents
 * both started warm while navigating independently.
 */

const cookie = (over: Record<string, unknown> = {}) => ({
  name: 'session',
  value: 'abc',
  domain: '.example.com',
  path: '/',
  expires: 1893456000,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  ...over,
});

describe('translating CDP cookies to a storage state', () => {
  it('carries the fields a login actually needs', () => {
    const [out] = cdpCookiesToStorageState([cookie()]).cookies;
    expect(out).toMatchObject({
      name: 'session',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  });

  it('marks a session cookie as -1, which is what Playwright expects', () => {
    // CDP reports 0 or a negative for "expires when the browser closes".
    // Passing that through as an epoch would make every session cookie look
    // long expired, and every agent would start logged out.
    expect(cdpCookiesToStorageState([cookie({ expires: 0 })]).cookies[0]?.expires).toBe(-1);
    expect(cdpCookiesToStorageState([cookie({ expires: -1 })]).cookies[0]?.expires).toBe(-1);
  });

  it('keeps a real expiry, as an integer', () => {
    const out = cdpCookiesToStorageState([cookie({ expires: 1893456000.7 })]).cookies[0];
    expect(out?.expires).toBe(1893456000);
    expect(Number.isInteger(out?.expires)).toBe(true);
  });

  it('defaults an unknown sameSite to Lax rather than dropping the cookie', () => {
    // CDP omits sameSite for plenty of real cookies. Dropping them would
    // silently lose logins; Lax is what a browser assumes anyway.
    expect(cdpCookiesToStorageState([cookie({ sameSite: undefined })]).cookies[0]?.sameSite).toBe(
      'Lax',
    );
    expect(cdpCookiesToStorageState([cookie({ sameSite: 'Nonsense' })]).cookies[0]?.sameSite).toBe(
      'Lax',
    );
  });

  it('passes None through, because that is what cross-site logins use', () => {
    expect(cdpCookiesToStorageState([cookie({ sameSite: 'None' })]).cookies[0]?.sameSite).toBe(
      'None',
    );
  });

  it('drops a cookie with no name, which nothing can use', () => {
    expect(cdpCookiesToStorageState([cookie({ name: '' })]).cookies).toHaveLength(0);
  });

  it('always includes an origins array, or Playwright rejects the file', () => {
    expect(cdpCookiesToStorageState([]).origins).toEqual([]);
  });
});
