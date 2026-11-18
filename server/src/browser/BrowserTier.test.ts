import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTier, tierOf, tiersPath, upgrade } from './BrowserTier.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tier-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('which browser a session gets', () => {
  it('starts light, because the heavy one is 1.3 GB', () => {
    expect(tierOf(dir, 's-1')).toBe('light');
  });

  it('upgrades once and stays upgraded while the browser lives', () => {
    expect(upgrade(dir, 's-1', 'cloudflare refused with 403')).toEqual({
      ok: true,
      already: false,
    });
    expect(tierOf(dir, 's-1')).toBe('real');
    expect(upgrade(dir, 's-1', 'again')).toEqual({ ok: true, already: true });
  });

  it('REFUSES past the cap rather than filling the machine', () => {
    // At 1.3 GB each this is the whole memory argument. A bad afternoon must
    // not be able to put ten of them up.
    expect(upgrade(dir, 'a', 'x', 1, 2).ok).toBe(true);
    expect(upgrade(dir, 'b', 'x', 1, 2).ok).toBe(true);
    const third = upgrade(dir, 'c', 'x', 1, 2);
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.reason).toContain('limit 2');
    expect(tierOf(dir, 'c')).toBe('light');
  });

  it('forgets a tier when the browser stops', () => {
    // A session that needed the heavy browser for one checkout does not need
    // it tomorrow, and a tier that survived would mean every chat that ever
    // hit one wall pays the gigabyte forever.
    upgrade(dir, 's-1', 'x');
    clearTier(dir, 's-1');
    expect(tierOf(dir, 's-1')).toBe('light');
  });

  it('treats an unreadable record as light', () => {
    // The safe direction: the cost of being wrong here is a refused page, not
    // a machine out of memory.
    writeFileSync(tiersPath(dir), 'not json at all');
    expect(tierOf(dir, 's-1')).toBe('light');
  });
});
