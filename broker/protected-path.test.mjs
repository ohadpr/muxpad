import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertProtectedPath } from './protected-path.mjs';

test(
  'macOS ACL grants are rejected even on an owner-only file',
  { skip: process.platform !== 'darwin' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'broker-acl-'));
    const file = join(dir, 'protected');
    try {
      writeFileSync(file, 'test only', { mode: 0o600 });
      execFileSync('/bin/chmod', ['+a', `user:${userInfo().username} allow read,write`, file]);
      assert.throws(() => assertProtectedPath(file, [0, process.getuid()], { mode: 0o600 }), /ACL/);
    } finally {
      execFileSync('/bin/chmod', ['-RN', dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── THE LINUX ARM ─────────────────────────────────────────────────────────
// Runs on the VM, skipped on the Mac — same shape as the macOS test above, and
// the reason the suite is run on BOTH machines rather than only where it was
// written. A POSIX ACL is the Linux mechanism that grants read access without
// touching the mode bits the loop already checks.
test(
  'POSIX ACL grants are rejected even on an owner-only file',
  { skip: process.platform !== 'linux' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'broker-acl-'));
    const file = join(dir, 'protected');
    try {
      writeFileSync(file, 'test only', { mode: 0o600 });
      execFileSync('/usr/bin/setfacl', ['-m', `u:${userInfo().username}:rw`, file]);
      assert.throws(() => assertProtectedPath(file, [0, process.getuid()], { mode: 0o600 }), /ACL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a DEFAULT ACL on an ancestor is rejected too',
  { skip: process.platform !== 'linux' },
  () => {
    // It grants on files created later rather than on this one, so nothing is
    // leaking yet — but a protected tree that hands out entries by default is
    // not protected, and the next file written there would be readable.
    const dir = mkdtempSync(join(tmpdir(), 'broker-acl-'));
    const file = join(dir, 'protected');
    try {
      writeFileSync(file, 'test only', { mode: 0o600 });
      execFileSync('/usr/bin/setfacl', ['-d', '-m', `u:${userInfo().username}:rw`, dir]);
      assert.throws(() => assertProtectedPath(file, [0, process.getuid()], { mode: 0o600 }), /ACL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('an unsupported platform refuses rather than skipping the check', () => {
  // The bug this guards against is the one the old code had by construction on
  // every non-macOS platform: a check that cannot run must not return quietly,
  // because a skipped inspection is indistinguishable from a passed one at the
  // call site — and these calls are what stand between an agent account and a
  // Slack token.
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
  try {
    assert.throws(() => assertProtectedPath('/', [0]), /not supported on sunos/);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
});
