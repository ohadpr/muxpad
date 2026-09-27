import { describe, expect, it } from 'vitest';
import { staleLockFiles } from './ProfileLock.js';

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
