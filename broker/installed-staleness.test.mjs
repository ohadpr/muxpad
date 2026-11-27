import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { brokerDrift, driftReport } from './installed-staleness.mjs';

/**
 * The fault this exists to make visible: the broker runs from a root-owned
 * copy, so editing broker/*.mjs changes nothing until install.sh runs — and
 * on this machine the installed copy sat thirteen days behind while fix after
 * fix landed in git and none of them ran.
 */
const dirs = () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const installed = mkdtempSync(join(tmpdir(), 'inst-'));
  return {
    repo,
    installed,
    clean: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(installed, { recursive: true, force: true });
    },
  };
};

test('a matching install is silent', () => {
  const d = dirs();
  writeFileSync(join(d.repo, 'a.mjs'), 'same');
  writeFileSync(join(d.installed, 'a.mjs'), 'same');
  const drift = brokerDrift(d.repo, d.installed);
  assert.deepEqual(drift.stale, []);
  assert.equal(driftReport(drift), null);
  d.clean();
});

test('it compares CONTENT, not timestamps', async () => {
  // install.sh copies, so an installed file is always newer than the repo's.
  // A timestamp check would report drift on every successful install.
  const d = dirs();
  writeFileSync(join(d.repo, 'a.mjs'), 'same');
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(d.installed, 'a.mjs'), 'same');
  assert.deepEqual(brokerDrift(d.repo, d.installed).stale, []);
  d.clean();
});

test('it names the files that differ, and what to run', () => {
  const d = dirs();
  writeFileSync(join(d.repo, 'msgvault.mjs'), 'new');
  writeFileSync(join(d.installed, 'msgvault.mjs'), 'old');
  const drift = brokerDrift(d.repo, d.installed);
  assert.deepEqual(drift.stale, ['msgvault.mjs']);
  const report = driftReport(drift);
  assert.match(report, /NOT the code in this repo/);
  assert.match(report, /msgvault\.mjs/);
  assert.match(report, /sudo bash broker\/install\.sh/);
  d.clean();
});

test('a module that was never installed counts too', () => {
  // The same fault one step earlier: a new file that install.sh has never
  // copied is code that cannot possibly be running.
  const d = dirs();
  writeFileSync(join(d.repo, 'brand-new.mjs'), 'x');
  const drift = brokerDrift(d.repo, d.installed);
  assert.deepEqual(drift.missing, ['brand-new.mjs']);
  assert.match(driftReport(drift), /never installed/);
  d.clean();
});

test('tests are not shipped code, and are not drift', () => {
  const d = dirs();
  writeFileSync(join(d.repo, 'a.test.mjs'), 'only in the repo');
  assert.deepEqual(brokerDrift(d.repo, d.installed).missing, []);
  d.clean();
});

test('a machine with no broker installed reports nothing', () => {
  // Not every machine runs one; "13 files are stale" there is noise.
  const d = dirs();
  writeFileSync(join(d.repo, 'a.mjs'), 'x');
  const drift = brokerDrift(d.repo, join(d.installed, 'nope'));
  assert.equal(drift.installed, false);
  assert.equal(driftReport(drift), null);
  d.clean();
});
