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
