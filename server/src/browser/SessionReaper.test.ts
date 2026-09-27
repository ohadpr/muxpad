import { describe, expect, it } from 'vitest';
import { isDisposableSessionProfile, sessionBrowsersToReap } from './SessionReaper.js';

/**
 * Stopping session browsers whose session is gone.
 *
 * Each one is a real Chrome — roughly 200 MB. One per agent tab, never
 * collected, on a machine that routinely has fifteen sessions open, is the
 * memory complaint that started this whole project, rebuilt by me from parts.
 */

const profiles = (...names: string[]) => names.map((profile) => ({ profile }));

describe('what gets reaped', () => {
  it('stops a session browser whose tab is gone', () => {
    expect(sessionBrowsersToReap(profiles('s-tab1', 's-tab2'), new Set(['tab1']))).toEqual([
      's-tab2',
    ]);
  });

  it('NEVER touches a person’s browser', () => {
    // `default` is the one a human logs into and the source of the shared jar.
    // Reaping it would throw away every login on the machine.
    expect(sessionBrowsersToReap(profiles('default', 'shopping'), new Set())).toEqual([]);
  });

  it('keeps a session browser whose tab is still open', () => {
    expect(sessionBrowsersToReap(profiles('s-tab1'), new Set(['tab1']))).toEqual([]);
  });

  it('reaps nothing when the tab list is unknown, rather than everything', () => {
    // An empty set from a failed read must not be read as "no tabs exist".
    // Passing null says so explicitly; that is the difference between a sweep
    // and an outage.
    expect(sessionBrowsersToReap(profiles('s-tab1', 's-tab2'), null)).toEqual([]);
  });

  it('matches the tab id case-insensitively, because profiles are lowercased', () => {
    // A ULID is uppercase and a profile name is not; comparing them raw would
    // reap every live session on the machine.
    expect(sessionBrowsersToReap(profiles('s-01m3abc'), new Set(['01M3ABC']))).toEqual([]);
  });
});

describe('clearing up after a reaped session', () => {
  // Stopping alone left the app row behind, disabled — and the sweep skipped
  // disabled rows, so nothing looked at them again. One permanent row per agent
  // session ever opened, each holding a port out of a hundred and a profile
  // directory on disk. Ninety-nine of them before anybody noticed.
  it('lets a session profile go', () => {
    expect(isDisposableSessionProfile('s-01m3j6k782sn07tt2p062s37tn')).toBe(true);
  });

  it('never the browser a person logs into', () => {
    // This one holds every login on the machine and is the source of the jar.
    expect(isDisposableSessionProfile('default')).toBe(false);
    expect(isDisposableSessionProfile('shopping')).toBe(false);
  });

  it('refuses path syntax, because this answer authorises a delete', () => {
    expect(isDisposableSessionProfile('s-../../default')).toBe(false);
    expect(isDisposableSessionProfile('s-a/b')).toBe(false);
    expect(isDisposableSessionProfile('s-a\\b')).toBe(false);
  });

  it('refuses the bare prefix', () => {
    expect(isDisposableSessionProfile('s-')).toBe(false);
  });
});
