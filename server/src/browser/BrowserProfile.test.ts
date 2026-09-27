import { describe, expect, it } from 'vitest';
import {
  BROWSER_APP_SLUG_PREFIX,
  BROWSER_PORT_RANGE,
  browserAppName,
  browserAppSlug,
  browserAppUrl,
  browserProfileDir,
  browserViewerPort,
  isBrowserAppSlug,
  normalizeProfileName,
  parseBrowserPort,
  pickBrowserPort,
  profileFromAppSlug,
} from './BrowserProfile.js';

/**
 * The naming and addressing rules for a muxpad-OWNED browser profile.
 *
 * The point of the whole module, in one sentence: a profile directory has
 * exactly ONE owner process, because Chrome takes an exclusive lock on it and
 * the September outage was ~20 agent sessions all opening the same directory.
 * "One owner" is enforced by making the owner an app, and an app is identified
 * by its slug — so the slug has to be a pure function of the profile name, with
 * no room for two spellings of the same profile to mint two owners.
 */
describe('profile names', () => {
  it('lower-cases and slugifies, so one profile cannot have two spellings', () => {
    expect(normalizeProfileName('Shopping')).toBe('shopping');
    expect(normalizeProfileName('  research  ')).toBe('research');
    expect(normalizeProfileName('My Amazon Login')).toBe('my-amazon-login');
    expect(normalizeProfileName('a__b--c')).toBe('a-b-c');
  });

  it('rejects anything that could escape the profiles directory', () => {
    // This is the one that matters: the name becomes a path segment.
    for (const bad of ['..', '../evil', 'a/b', 'a\\b', '.', './x', '']) {
      expect(() => normalizeProfileName(bad), bad).toThrow(/profile name/i);
    }
  });

  it('rejects a name that slugifies to nothing', () => {
    expect(() => normalizeProfileName('!!!')).toThrow(/profile name/i);
  });

  it('caps length, because the slug becomes a pane title and an app row', () => {
    expect(() => normalizeProfileName('x'.repeat(65))).toThrow(/profile name/i);
    expect(normalizeProfileName('x'.repeat(64))).toHaveLength(64);
  });
});

describe('the profile directory', () => {
  it('lives under the data dir, one directory per profile', () => {
    expect(browserProfileDir('/data', 'shopping')).toBe('/data/browser-profiles/shopping');
  });

  it('normalizes on the way in, so a caller cannot sneak a traversal past it', () => {
    expect(browserProfileDir('/data', 'Shopping')).toBe('/data/browser-profiles/shopping');
    expect(() => browserProfileDir('/data', '../../etc')).toThrow(/profile name/i);
  });
});

describe('the app row that owns a profile', () => {
  it('derives the slug from the profile, so the owner is unique per profile', () => {
    expect(browserAppSlug('shopping')).toBe('browser-shopping');
    expect(browserAppSlug('Shopping')).toBe(browserAppSlug('shopping'));
  });

  it('round-trips slug -> profile', () => {
    expect(profileFromAppSlug('browser-shopping')).toBe('shopping');
    expect(profileFromAppSlug(browserAppSlug('research'))).toBe('research');
  });

  it('recognises its own rows and disowns everything else', () => {
    expect(isBrowserAppSlug(`${BROWSER_APP_SLUG_PREFIX}shopping`)).toBe(true);
    expect(isBrowserAppSlug('tunnel')).toBe(false);
    expect(isBrowserAppSlug('browser-')).toBe(false);
    expect(profileFromAppSlug('tunnel')).toBeNull();
  });

  it('has a human name that says which profile it is', () => {
    expect(browserAppName('shopping')).toContain('shopping');
  });
});

describe('addressing', () => {
  it('binds loopback — never 0.0.0.0, this machine is on a tailnet', () => {
    expect(browserAppUrl(9410)).toBe('http://127.0.0.1:9410');
  });

  it('reads the port back off a stored app row, which is where it is persisted', () => {
    expect(parseBrowserPort(browserAppUrl(9410))).toBe(9410);
    expect(parseBrowserPort('http://127.0.0.1:9410/')).toBe(9410);
  });

  it('returns null rather than a wrong number for a row it cannot read', () => {
    for (const bad of ['', 'not a url', 'http://127.0.0.1', 'https://example.com/x']) {
      expect(parseBrowserPort(bad), bad).toBeNull();
    }
  });
});

describe('the viewer port', () => {
  it('is derived from the CDP port, so it is stable across restarts too', () => {
    expect(browserViewerPort(9410)).toBe(9510);
    expect(browserViewerPort(9410)).toBe(browserViewerPort(9410));
  });

  it('never collides with another profile CDP port', () => {
    // The offset must clear the whole CDP range, or profile A's viewer lands on
    // profile B's debugging port and the two fight silently.
    const [lo, hi] = BROWSER_PORT_RANGE;
    expect(browserViewerPort(lo)).toBeGreaterThan(hi);
  });
});

describe('port allocation', () => {
  const [lo, hi] = BROWSER_PORT_RANGE;

  it('is deterministic for a profile, so a restart keeps the same URL', () => {
    // The pane's face_url outlives the process. If the port moved on every
    // restart, every card in every chat would point at a dead port.
    expect(pickBrowserPort('shopping', new Set())).toBe(pickBrowserPort('shopping', new Set()));
  });

  it('stays inside the reserved range', () => {
    for (const name of ['a', 'shopping', 'research', 'default', 'x'.repeat(64)]) {
      const p = pickBrowserPort(name, new Set());
      expect(p, name).toBeGreaterThanOrEqual(lo);
      expect(p, name).toBeLessThanOrEqual(hi);
    }
  });

  it('gives different profiles different ports', () => {
    const seen = new Set<number>();
    for (const name of ['default', 'shopping', 'research', 'amazon', 'gong']) {
      seen.add(pickBrowserPort(name, seen));
    }
    expect(seen.size).toBe(5);
  });

  it('steps off a port already taken instead of colliding', () => {
    const first = pickBrowserPort('shopping', new Set());
    const second = pickBrowserPort('shopping', new Set([first]));
    expect(second).not.toBe(first);
    expect(second).toBeGreaterThanOrEqual(lo);
    expect(second).toBeLessThanOrEqual(hi);
  });

  it('throws rather than returning a port outside the range when the range is full', () => {
    const full = new Set<number>();
    for (let p = lo; p <= hi; p++) full.add(p);
    expect(() => pickBrowserPort('shopping', full)).toThrow(/no free/i);
  });
});
