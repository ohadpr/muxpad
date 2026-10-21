import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPaneKeys,
  initPaneKeys,
  paneKeyFor,
  verifyPaneKey,
  withPaneKey,
} from './pane-key.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'panekey-'));
  initPaneKeys(dir);
});
afterEach(() => {
  __resetPaneKeys();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A pane proves which pane it is with a key the server minted for it and put
 * in its spawn environment. This replaced a process-ancestry walk, which could
 * not be forged at all but needed pane pids — a fact only ptyd has, so getting
 * at it meant a ptyd protocol change, which restarts the daemon that owns
 * every terminal on the machine.
 */
describe('pane keys', () => {
  it('differ per pane', () => {
    expect(paneKeyFor('pane-a')).not.toBe(paneKeyFor('pane-b'));
  });

  it('survive a restart, because they are derived and not stored', () => {
    const before = paneKeyFor('pane-a');
    __resetPaneKeys();
    initPaneKeys(dir);
    expect(paneKeyFor('pane-a')).toBe(before);
  });

  it('cannot be computed without the install secret', () => {
    const mine = paneKeyFor('pane-a');
    const other = mkdtempSync(join(tmpdir(), 'panekey-'));
    try {
      __resetPaneKeys();
      initPaneKeys(other);
      expect(paneKeyFor('pane-a')).not.toBe(mine);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('verify only against their own pane', () => {
    // The spoof this exists to stop: naming a work pane from a personal one.
    expect(verifyPaneKey('pane-a', paneKeyFor('pane-a'))).toBe(true);
    expect(verifyPaneKey('pane-b', paneKeyFor('pane-a'))).toBe(false);
  });

  it('refuse empty, short and absent keys', () => {
    for (const k of ['', null, undefined, 'x', `${paneKeyFor('pane-a')}x`]) {
      expect(verifyPaneKey('pane-a', k)).toBe(false);
    }
  });

  it('refuse everything before init — a refusal, never an admission', () => {
    __resetPaneKeys();
    expect(paneKeyFor('pane-a')).toBeNull();
    expect(verifyPaneKey('pane-a', 'anything')).toBe(false);
  });

  it('keep the install secret 0600', () => {
    // eslint-disable-next-line no-bitwise
    expect(statSync(join(dir, 'pane-key-secret')).mode & 0o777).toBe(0o600);
  });

  it('replace a corrupt secret rather than refusing to boot', () => {
    writeFileSync(join(dir, 'pane-key-secret'), 'junk\n');
    __resetPaneKeys();
    initPaneKeys(dir);
    expect(paneKeyFor('pane-a')).toMatch(/^[a-f0-9]{32}$/);
  });

  it('still issues keys when the data dir cannot be written', () => {
    const ro = mkdtempSync(join(tmpdir(), 'panekey-ro-'));
    chmodSync(ro, 0o500);
    try {
      __resetPaneKeys();
      initPaneKeys(ro);
      expect(paneKeyFor('pane-a')).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      chmodSync(ro, 0o700);
      rmSync(ro, { recursive: true, force: true });
    }
  });
});

describe('withPaneKey', () => {
  it('adds the key without disturbing the pane’s own env', () => {
    expect(withPaneKey({ FOO: 'bar' }, 'pane-a')).toEqual({
      FOO: 'bar',
      MUXPAD_PANE_KEY: paneKeyFor('pane-a'),
      MUXPAD_PANE_PROOF: paneKeyFor('pane-a'),
    });
  });

  it('handles a pane with no env of its own', () => {
    expect(withPaneKey(null, 'pane-a')).toEqual({
      MUXPAD_PANE_KEY: paneKeyFor('pane-a'),
      MUXPAD_PANE_PROOF: paneKeyFor('pane-a'),
    });
    expect(withPaneKey(undefined, 'pane-a')).toEqual({
      MUXPAD_PANE_KEY: paneKeyFor('pane-a'),
      MUXPAD_PANE_PROOF: paneKeyFor('pane-a'),
    });
  });

  it('overwrites caller aliases with this pane’s verified proof', () => {
    const env = withPaneKey({ MUXPAD_PANE_PROOF: 'wrong', MUXPAD_PANE_KEY: 'wrong' }, 'pane-a');
    expect(verifyPaneKey('pane-a', env.MUXPAD_PANE_PROOF)).toBe(true);
    expect(verifyPaneKey('pane-b', env.MUXPAD_PANE_PROOF)).toBe(false);
  });

  it('adds NOTHING before init rather than an empty key', () => {
    // An empty value in the environment would read as "I have a key" to
    // anything checking for presence, and fail verification later — further
    // from the problem than the cause.
    __resetPaneKeys();
    expect(withPaneKey({ FOO: 'bar' }, 'pane-a')).toEqual({ FOO: 'bar' });
  });
});
