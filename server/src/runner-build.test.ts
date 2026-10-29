import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIdOf, currentBuildId, resetBuildIdCache, runnerIsStale } from './runner-build.js';

/**
 * STALE MEANS "RUNNING DIFFERENT CODE", NOT "OLD".
 *
 * A runner started three weeks ago on a build nothing has changed since is
 * current. A runner started ten minutes before a deploy is not. Age is a
 * proxy for the thing and it is wrong in both directions — see the module.
 */
afterEach(resetBuildIdCache);

describe('the build id', () => {
  it('is stable while nothing is rebuilt', () => {
    const a = currentBuildId();
    resetBuildIdCache();
    expect(currentBuildId()).toBe(a);
  });

  it('is cached, so a reconnect storm does not walk the tree per hello', () => {
    const a = currentBuildId(1_000);
    expect(currentBuildId(1_100)).toBe(a);
  });
});

describe('runnerIsStale', () => {
  it('says no when the runner reports what the server is running', () => {
    expect(runnerIsStale('abc', 'abc')).toBe(false);
  });

  it('says yes when the two differ', () => {
    expect(runnerIsStale('abc', 'def')).toBe(true);
  });

  it('says yes when the runner reports nothing at all', () => {
    // The field arrived with this check, so a runner that does not send one
    // predates every change since — which is the whole population this was
    // written for: 21 of 28 runners on the install that prompted it.
    expect(runnerIsStale(undefined, 'abc')).toBe(true);
  });

  it('does NOT use the server’s start time, which over-reports', () => {
    // The cheap signal is "did this runner start before the server process",
    // and it marks every open pane stale after any restart — a crash, a
    // config change, a reboot — while every one of them runs the right code.
    // A notice that cries wolf after an ordinary restart is one people learn
    // to ignore.
    const src = readFileSync(join(__dirname, 'runner-build.ts'), 'utf8');
    expect(src).not.toMatch(/process\.uptime|startedAt|serverStart/);
  });
});

describe('what moves the id', () => {
  it('follows a rebuild of ANY module, not just the entry file', () => {
    // `index.js` is frequently byte-identical across a build that changed a
    // module it imports — which is exactly the change that caused the bug
    // this exists for: the agent instructions live in another file. So the id
    // is the newest mtime in the TREE, and the test proves the tree is
    // walked by moving a file the entry does not name.
    const dir = mkdtempSync(join(tmpdir(), 'muxpad-build-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'index.js'), 'entry');
    writeFileSync(join(dir, 'nested', 'other.js'), 'module');
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(dir, 'index.js'), old, old);
    utimesSync(join(dir, 'nested', 'other.js'), old, old);
    const before = buildIdOf(dir);
    // Touch only the nested module, as `tsc -b` would for a changed import.
    const now = new Date();
    utimesSync(join(dir, 'nested', 'other.js'), now, now);
    expect(buildIdOf(dir)).not.toBe(before);
  });

  it('ignores files that are not code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muxpad-build-'));
    writeFileSync(join(dir, 'index.js'), 'entry');
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(dir, 'index.js'), old, old);
    const before = buildIdOf(dir);
    writeFileSync(join(dir, 'notes.md'), 'not a build');
    expect(buildIdOf(dir)).toBe(before);
  });
});
