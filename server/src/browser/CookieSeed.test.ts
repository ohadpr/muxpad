import { describe, expect, it } from 'vitest';
import { storageStateToCdpCookies } from './CookieJar.js';

/**
 * Seeding a fresh browser from the shared jar.
 *
 * The other half of CookieJar: that one exports what a PERSON has logged into,
 * this one pours it into a browser muxpad has just launched for an agent. Same
 * file, opposite direction, and the round trip has to survive — a login that
 * exports cleanly and imports as garbage is worse than no jar, because the
 * browser then looks warm and behaves cold.
 */

const stored = (over: Record<string, unknown> = {}) => ({
  name: 'session',
  value: 'abc',
  domain: '.example.com',
  path: '/',
  expires: 1893456000,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
  ...over,
});

describe('pouring a jar into a browser', () => {
  it('carries every field CDP needs to set a cookie', () => {
    const [out] = storageStateToCdpCookies({ cookies: [stored()], origins: [] });
    expect(out).toMatchObject({
      name: 'session',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires: 1893456000,
    });
  });

  it('drops the expiry for a session cookie rather than sending -1', () => {
    // CDP treats a NEGATIVE expires as a date in 1969, so the cookie is dead on
    // arrival. A session cookie is expressed by omitting it entirely.
    const [out] = storageStateToCdpCookies({ cookies: [stored({ expires: -1 })], origins: [] });
    expect(out).not.toHaveProperty('expires');
  });

  it('skips a cookie that has already expired', () => {
    // Sending them is harmless but pointless, and it makes the seeded count a
    // lie about how warm the browser actually is.
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(
      storageStateToCdpCookies({ cookies: [stored({ expires: past })], origins: [] }),
    ).toHaveLength(0);
  });

  it('survives a jar with no cookies, and one that is malformed', () => {
    expect(storageStateToCdpCookies({ cookies: [], origins: [] })).toEqual([]);
    expect(storageStateToCdpCookies(null as never)).toEqual([]);
    expect(storageStateToCdpCookies({ cookies: 'nope' } as never)).toEqual([]);
  });
});
