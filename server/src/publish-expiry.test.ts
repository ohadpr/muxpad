import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIFESPAN_DAYS,
  baseSlugOf,
  clearLifespan,
  expireNow,
  expiryOf,
  extendLifespan,
  isExpired,
  loadExpiryStore,
  setLifespan,
} from './publish-expiry.js';

/**
 * A PUBLIC LINK WITH A HORIZON, AND BYTES THAT OUTLIVE IT.
 *
 * The rule the user asked for: links stop working after a week so the open
 * internet cannot keep reading a report published for a ten-minute look, but
 * the files stay so any of them can be brought back or repaired.
 */
const DAY = 86_400_000;
const dir = () => mkdtempSync(join(tmpdir(), 'mux-expiry-'));

describe('publish expiry', () => {
  it('defaults to a week', () => {
    const d = dir();
    const now = 1_700_000_000_000;
    const at = setLifespan(d, 'report-7k3mqp2x', DEFAULT_LIFESPAN_DAYS, now);
    expect(at).toBe(now + 7 * DAY);
    expect(isExpired(d, 'report-7k3mqp2x', now + 6 * DAY)).toBe(false);
    expect(isExpired(d, 'report-7k3mqp2x', now + 8 * DAY)).toBe(true);
  });

  it('treats a slug with NO record as never expiring', () => {
    // Every artifact published before this existed. Silently retiring links
    // the user may already have sent is not a migration.
    const d = dir();
    expect(expiryOf(d, 'legacy-slug')).toBeNull();
    expect(isExpired(d, 'legacy-slug')).toBe(false);
  });

  it('expires a rotation with its owner', () => {
    // `/slug@2/` is a previous version of the same artifact. If it outlived
    // the expiry, the link would still be readable one character away.
    const d = dir();
    const now = 1_700_000_000_000;
    setLifespan(d, 'deck-abc23456', 1, now);
    expect(isExpired(d, 'deck-abc23456@2', now + 2 * DAY)).toBe(true);
    expect(baseSlugOf('deck-abc23456@3')).toBe('deck-abc23456');
  });

  it('extends from NOW, so a lapsed link comes back for the full term', () => {
    // The whole reason the verb exists is "get me that page back". Extending
    // from the OLD expiry would hand back a link that is still dead.
    const d = dir();
    const now = 1_700_000_000_000;
    setLifespan(d, 'old-abc23456', 1, now);
    const at = extendLifespan(d, 'old-abc23456', 7, now + 30 * DAY);
    expect(at).toBe(now + 30 * DAY + 7 * DAY);
    expect(isExpired(d, 'old-abc23456', now + 31 * DAY)).toBe(false);
  });

  it('extends a LIVE link from its own expiry, not from today', () => {
    const d = dir();
    const now = 1_700_000_000_000;
    setLifespan(d, 'live-abc23456', 7, now);
    const at = extendLifespan(d, 'live-abc23456', 7, now + DAY);
    expect(at).toBe(now + 7 * DAY + 7 * DAY);
  });

  it('expires now without touching the record of what it is', () => {
    const d = dir();
    const now = 1_700_000_000_000;
    setLifespan(d, 'live-abc23456', 7, now);
    expireNow(d, 'live-abc23456', now);
    expect(isExpired(d, 'live-abc23456', now)).toBe(true);
  });

  it('clears a horizon back to never', () => {
    const d = dir();
    setLifespan(d, 'keep-abc23456', 1);
    clearLifespan(d, 'keep-abc23456');
    expect(expiryOf(d, 'keep-abc23456')).toBeNull();
  });

  it('fails OPEN on a corrupt store — one bad file must not dark every link', () => {
    const d = dir();
    writeFileSync(join(d, 'publish-expiry.json'), '{ not json');
    expect(loadExpiryStore(d).slugs).toEqual({});
    expect(isExpired(d, 'anything')).toBe(false);
  });

  it('keeps the store OUT of the served tree', () => {
    // <dataDir>/public is the public root. A horizon file inside it would be
    // a public list of everything that exists.
    const d = dir();
    setLifespan(d, 'x-abc23456', 1);
    expect(() => readFileSync(join(d, 'publish-expiry.json'))).not.toThrow();
    expect(() => readFileSync(join(d, 'public', 'publish-expiry.json'))).toThrow();
  });
});
