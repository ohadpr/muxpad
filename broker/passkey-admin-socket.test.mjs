import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listenPasskeyAdmin } from './passkey-admin-socket.mjs';
test('admin listener refuses live, regular, symlink and wrong-mode paths without replacement', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'pka-'));
  chmodSync(dir, 0o700);
  const path = dir + '/a';
  const server = createServer();
  try {
    await listenPasskeyAdmin(server, path, { inspectACL: false });
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    await assert.rejects(listenPasskeyAdmin(createServer(), path, { inspectACL: false }), /live/);
    assert.equal(server.listening, true);
    await new Promise((r) => server.close(r));
    writeFileSync(path, 'x');
    await assert.rejects(listenPasskeyAdmin(createServer(), path, { inspectACL: false }), /Unsafe/);
    rmSync(path);
    symlinkSync(dir + '/other', path);
    await assert.rejects(listenPasskeyAdmin(createServer(), path, { inspectACL: false }), /Unsafe/);
  } finally {
    if (server.listening) await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
