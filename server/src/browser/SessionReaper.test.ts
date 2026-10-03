import { describe, expect, it } from 'vitest';
import {
  isDisposableSessionProfile,
  sessionBrowsersToReap,
  strandedProfilesToRemove,
} from './SessionReaper.js';

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

describe('a chat you have archived is a chat you have finished with', () => {
  /**
   * The reaper asked which tabs EXIST. Archiving keeps the row — it is how you
   * finish with a chat, and what the sidebar swipe does — so an archived chat's
   * browser was counted as wanted forever. Measured on a real machine before
   * this: 45 archived chats holding 45 browsers and 418 MB, seven still running
   * Chrome.
   */
  it('reaps a browser whose chat has been archived', () => {
    // The caller passes only LIVE tabs, so an archived one is simply absent —
    // this is the rule that absence now means archived as well as deleted.
    expect(sessionBrowsersToReap([{ profile: 's-abc' }], new Set(['other']))).toEqual(['s-abc']);
  });

  it('keeps one whose chat is still open', () => {
    expect(sessionBrowsersToReap([{ profile: 's-abc' }], new Set(['ABC']))).toEqual([]);
  });
});

/**
 * THE DIRECTORIES NO ROW NAMES.
 *
 * The row-driven sweep walks app ROWS, so a directory whose row is gone is
 * invisible to it forever. They were made by the reaper deleting the row BEFORE
 * the directory: an `rm` that raced the Chrome still writing into the profile
 * threw ENOTEMPTY, the row was already gone, and nothing pointed at the
 * directory again. Found on a real machine: 48 directories against 28 rows, 42
 * stranded, 147 MB — and 24 aborted sweeps in the log, because the try also sat
 * outside the loop so the first failure skipped every profile after it.
 */
describe('stranded profile directories', () => {
  it('takes a session directory that no row names', () => {
    expect(strandedProfilesToRemove(['s-gone', 's-owned'], new Set(['s-owned']))).toEqual([
      's-gone',
    ]);
  });

  it('NEVER takes `default`, nor the shared cookie jar beside it', () => {
    // The whole reason the decision is a pure function: `default` is the
    // browser a person drives and the source of every agent's logins, and
    // `default.cookies.json` is that jar. readdir hands back both, as files and
    // directories alike, and this is the only thing standing between them and
    // an rm -rf.
    expect(
      strandedProfilesToRemove(
        ['default', 'default.cookies.json', 'shopping', 'banking'],
        new Set(),
      ),
    ).toEqual([]);
  });

  it('refuses anything with path syntax in it, row or no row', () => {
    // Belt and braces over the name normaliser. This answer authorises an rm.
    expect(
      strandedProfilesToRemove(['s-../../etc', 's-a/b', 's-a\\b', '../s-x'], new Set()),
    ).toEqual([]);
  });

  it('refuses the bare prefix — that is the prefix, not a session', () => {
    expect(strandedProfilesToRemove(['s-'], new Set())).toEqual([]);
  });

  it('is empty when every directory is owned', () => {
    expect(strandedProfilesToRemove(['s-a', 's-b'], new Set(['s-a', 's-b']))).toEqual([]);
  });

  it('agrees with the guard it shares with the row-driven sweep', () => {
    // One rule, two callers: a name this accepts must be one the other would
    // also delete, or the two sweeps disagree about what is disposable.
    for (const name of ['s-x', 'default', 'default.cookies.json', 's-', '../s-x']) {
      expect({ name, stranded: strandedProfilesToRemove([name], new Set()).length > 0 }).toEqual({
        name,
        stranded: isDisposableSessionProfile(name),
      });
    }
  });
});
