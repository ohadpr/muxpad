import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Execute the actual rollover block against disposable, unprivileged trees.
// Existing root ownership/ACL validation is replaced only at the fixture boundary;
// no updater entrypoint, service command or installed state is accessed.
const source = readFileSync(new URL('./update-code.sh', import.meta.url), 'utf8');
const rollover = source
  .split('# BEGIN COMPLETED RELEASE ROLLOVER\n')[1]
  .split('# END COMPLETED RELEASE ROLLOVER')[0]
  .replaceAll('/bin/mv ', 'move_fixture ');
const oldRelease = 'a'.repeat(64);
const newRelease = 'b'.repeat(64);
function fixture(phase = 'ready') {
  const dest = mkdtempSync(join(tmpdir(), 'broker-rollover-'));
  for (const part of ['code.previous', 'code.next']) {
    mkdirSync(join(dest, part));
    writeFileSync(join(dest, part, 'payload'), part);
  }
  writeFileSync(join(dest, 'code-update'), `${oldRelease}\n${phase}\n`);
  const archive = join(dest, 'completed-updates', oldRelease);
  return { dest, archive, clean: () => rmSync(dest, { recursive: true, force: true }) };
}
function run(dest, release = newRelease, failMove = 0) {
  return spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-s', '--', dest, release, String(failMove)],
    {
      input: `set -euo pipefail
DEST=$1
RELEASE=$2
FAIL_MOVE=$3
MARKER="$DEST/code-update"
move_count=0
check_path() { [[ -e $1 && ! -L $1 ]] || exit 51; }
move_fixture() { move_count=$((move_count+1)); [[ $move_count != "$FAIL_MOVE" ]] || return 52; /bin/mv "$@"; }
${rollover}`,
      encoding: 'utf8',
    },
  );
}
test('completed release is preserved before a new release can prepare', () => {
  const f = fixture();
  try {
    assert.equal(run(f.dest).status, 0);
    assert.equal(existsSync(join(f.dest, 'code-update')), false);
    for (const part of ['code.previous', 'code.next']) {
      assert.equal(existsSync(join(f.dest, part)), false);
      assert.equal(readFileSync(join(f.archive, part, 'payload'), 'utf8'), part);
    }
    assert.equal(readFileSync(join(f.archive, 'marker'), 'utf8'), `${oldRelease}\nready\n`);
    assert.equal(run(f.dest).status, 0);
  } finally {
    f.clean();
  }
});
for (const failMove of [2, 3])
  test(`rollover resumes after interruption at move ${failMove}`, () => {
    const f = fixture();
    try {
      assert.equal(run(f.dest, newRelease, failMove).status, 52);
      assert.equal(existsSync(join(f.dest, 'code-update')), true);
      assert.equal(run(f.dest).status, 0);
      for (const part of ['code.previous', 'code.next'])
        assert.equal(readFileSync(join(f.archive, part, 'payload'), 'utf8'), part);
      assert.equal(existsSync(join(f.archive, 'marker')), true);
    } finally {
      f.clean();
    }
  });
test('unfinished releases remain pinned and same-release retries retain their trees', () => {
  const f = fixture('installing');
  try {
    assert.notEqual(run(f.dest).status, 0);
    assert.equal(existsSync(join(f.dest, 'completed-updates')), false);
    assert.equal(run(f.dest, oldRelease).status, 0);
    assert.equal(readFileSync(join(f.dest, 'code-update'), 'utf8'), `${oldRelease}\ninstalling\n`);
    assert.equal(existsSync(join(f.dest, 'code.next')), true);
  } finally {
    f.clean();
  }
});
test('rollover refuses symlinked completed trees without moving the marker', () => {
  const f = fixture();
  try {
    rmSync(join(f.dest, 'code.previous'), { recursive: true });
    symlinkSync(join(f.dest, 'code.next'), join(f.dest, 'code.previous'));
    assert.notEqual(run(f.dest).status, 0);
    assert.equal(existsSync(join(f.dest, 'code-update')), true);
  } finally {
    f.clean();
  }
});
