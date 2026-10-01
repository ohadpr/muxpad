import { existsSync, lstatSync, symlinkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearStaleProfileLock, staleLockFiles } from './ProfileLock.js';

/**
 * Chrome's profile lock, after an unclean exit.
 *
 * THE FAILURE THIS PREVENTS, observed live: Chrome was killed without a chance
 * to clean up, leaving `SingletonLock` pointing at a pid that no longer exists.
 * Every subsequent launch died on startup — `No rendezvous client, terminating
 * process (parent died?)` — so `muxpad serve` restarted it, and it died again,
 * forever. A crash-loop that no amount of supervision can escape, because the
 * thing blocking it is a file.
 *
 * The owner-per-profile rule makes this safe to clear: if OUR host is starting
 * and nothing else may hold this profile, a lock left behind is by definition
 * stale. That is the whole argument — it would be reckless in a world where
 * another process might legitimately hold it, and this subsystem exists
 * precisely to ensure none can.
 */

describe('what counts as a stale lock', () => {
  it('names the three files Chrome leaves behind', () => {
    const files = staleLockFiles('/data/browser-profiles/default');
    expect(files).toEqual([
      '/data/browser-profiles/default/SingletonLock',
      '/data/browser-profiles/default/SingletonCookie',
      '/data/browser-profiles/default/SingletonSocket',
    ]);
  });

  it('stays inside the profile directory it was given', () => {
    // These paths are deleted. Nothing may point outside the profile.
    for (const f of staleLockFiles('/data/browser-profiles/default')) {
      expect(f.startsWith('/data/browser-profiles/default/')).toBe(true);
      expect(f).not.toContain('..');
    }
  });
});

describe('actually clearing a lock, on a real disk', () => {
  /**
   * Only the path arithmetic had ever been tested. The function that DELETES ran
   * against nothing — and it was wrong: `rmSync` with `force` does not throw for
   * a file that is not there, so removing unconditionally and recording the
   * removal reported all three lock files as cleared on every clean start.
   *
   * This is the lock that, left behind by a crash, makes every relaunch fail
   * with an error that looks nothing like its cause — so a test of it against a
   * real directory is worth having.
   */
  const dirs: string[] = [];
  const tempProfile = () => {
    const d = mkdtempSync(join(tmpdir(), 'profile-lock-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('removes a lock that a crash left behind', () => {
    const dir = tempProfile();
    writeFileSync(join(dir, 'SingletonLock'), 'pid-of-a-dead-browser');
    expect(clearStaleProfileLock(dir)).toEqual([join(dir, 'SingletonLock')]);
    expect(existsSync(join(dir, 'SingletonLock'))).toBe(false);
  });

  it('removes dangling Chrome lock and socket symlinks', () => {
    const dir = tempProfile();
    const paths = ['SingletonLock', 'SingletonSocket'].map((name) => join(dir, name));
    for (const path of paths) symlinkSync('nonexistent-host-1234', path);
    expect(clearStaleProfileLock(dir)).toEqual(paths);
    for (const path of paths) expect(() => lstatSync(path)).toThrow();
  });

  it('reports NOTHING when there was nothing to clear', () => {
    // The clean case, and the one the old version got wrong: it claimed all
    // three every time.
    expect(clearStaleProfileLock(tempProfile())).toEqual([]);
  });

  it('clears all three when all three are there', () => {
    const dir = tempProfile();
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      writeFileSync(join(dir, f), 'x');
    }
    expect(clearStaleProfileLock(dir)).toHaveLength(3);
  });

  it('leaves the rest of the profile alone', () => {
    // It is somebody's logins in there.
    const dir = tempProfile();
    writeFileSync(join(dir, 'SingletonLock'), 'x');
    writeFileSync(join(dir, 'Cookies'), 'precious');
    clearStaleProfileLock(dir);
    expect(existsSync(join(dir, 'Cookies'))).toBe(true);
  });

  it('is fine with a profile directory that does not exist yet', () => {
    // The ordinary first run.
    expect(() => clearStaleProfileLock('/definitely/not/here')).not.toThrow();
  });
});
