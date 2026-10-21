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
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listenPrivateSocket } from './socket-listener.mjs';

test('private socket serves requests and refuses regular files, symlinks and public parent', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'muxsock-'));
  chmodSync(dir, 0o700);
  const path = join(dir, 'broker.sock');
  const server = createServer((_req, res) => res.end('protected'));
  try {
    // Test UID-owned temporary ancestors; production requires protected root ancestry.
    await listenPrivateSocket(server, path, { inspectACL: false });
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(server.address(), path);
    const body = await new Promise((resolve, reject) => {
      const req = request({ socketPath: path, path: '/' }, (res) => {
        let body = '';
        res.on('data', (data) => {
          body += data;
        });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'protected');
    await new Promise((resolve) => server.close(resolve));
    writeFileSync(path, 'not a socket');
    assert.throws(
      () => listenPrivateSocket(createServer(), path, { inspectACL: false }),
      /unexpected/,
    );
    rmSync(path);
    symlinkSync(join(dir, 'elsewhere'), path);
    assert.throws(
      () => listenPrivateSocket(createServer(), path, { inspectACL: false }),
      /unexpected/,
    );
    rmSync(path);
    chmodSync(dir, 0o755);
    assert.throws(() => listenPrivateSocket(createServer(), path, { inspectACL: false }), /mode/);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
