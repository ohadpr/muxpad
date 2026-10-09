import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOrCreateSayKey } from './say-key.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saykey-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The key exists so that text CONTAINING `muxpad say`'s marker is
 * distinguishable from an invocation of it — `cat`, a test run, a fetched
 * page, or `grep -rn muxpad-said .` while working on the feature.
 *
 * It is not a secret and nothing here treats it as one. What it must be is
 * STABLE: a transcript is re-read for months, so a key that changed on restart
 * would un-say every message spoken before it.
 */
describe('the say key', () => {
  it('is stable across calls — a restart must not un-say old messages', () => {
    const first = readOrCreateSayKey(dir);
    expect(readOrCreateSayKey(dir)).toBe(first);
    expect(readFileSync(join(dir, 'say-key'), 'utf8').trim()).toBe(first);
  });

  it('is hex of the length the parser will accept', () => {
    // The key is interpolated into a RegExp. The parser rejects anything that
    // is not plain hex, so minting something else would silently never match.
    expect(readOrCreateSayKey(dir)).toMatch(/^[a-f0-9]{32}$/);
  });

  it('differs per install', () => {
    const other = mkdtempSync(join(tmpdir(), 'saykey-'));
    try {
      expect(readOrCreateSayKey(dir)).not.toBe(readOrCreateSayKey(other));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('replaces a corrupt file rather than refusing to boot', () => {
    writeFileSync(join(dir, 'say-key'), 'not a key\n');
    expect(readOrCreateSayKey(dir)).toMatch(/^[a-f0-9]{32}$/);
  });

  it('still answers when the data dir cannot be written', () => {
    // Per-process rather than per-install, which costs old messages their
    // voice — but booting is more important than a cosmetic file.
    chmodSync(dir, 0o500);
    try {
      expect(readOrCreateSayKey(dir)).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('is written 0600', () => {
    readOrCreateSayKey(dir);
    // eslint-disable-next-line no-bitwise
    expect(statSync(join(dir, 'say-key')).mode & 0o777).toBe(0o600);
  });
});
