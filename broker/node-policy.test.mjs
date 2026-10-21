import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { checkNodeAuthority } from './node-policy.mjs';
test('private authority client uses only Unix transport, exact peer bytes and bounded failure without retries', async () => {
  const dir = mkdtempSync('/private/tmp/mux-authority-test-');
  const socketPath = `${dir}/authority.sock`;
  const peer = {
    nodeID: 'node',
    ownerID: '42',
    policy: 'digest',
    generation: 'gen',
    authorizationID: 'rev',
    ip: '100.64.0.2',
  };
  let calls = 0;
  let outcome = 200;
  let response;
  const server = createServer(async (req, res) => {
    calls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.equal(req.url, '/check');
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(raw), peer);
    if (outcome) {
      res.writeHead(outcome);
      res.end(response ?? JSON.stringify(peer));
    }
  });
  server.listen(socketPath);
  await once(server, 'listening');
  try {
    assert.equal(await checkNodeAuthority(peer, { socketPath }), true);
    for (const bad of [
      { ...peer, generation: 'old' },
      { ...peer, authorizationID: 'other' },
      { ...peer, nodeID: 'reassigned' },
      { ...peer, ownerID: '99' },
      { ...peer, extra: 'unknown' },
    ]) {
      response = JSON.stringify(bad);
      assert.equal(await checkNodeAuthority(peer, { socketPath }), false);
    }
    response = '{"nodeID":"node","nodeID":"node"}';
    assert.equal(await checkNodeAuthority(peer, { socketPath }), false);
    response = 'x'.repeat(4097);
    assert.equal(await checkNodeAuthority(peer, { socketPath }), false);
    response = undefined;
    outcome = 403;
    assert.equal(await checkNodeAuthority(peer, { socketPath }), false);
    outcome = 0;
    assert.equal(await checkNodeAuthority(peer, { socketPath, timeout: 25 }), false);
    assert.equal(calls, 10);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true });
  }
  assert.equal(await checkNodeAuthority(peer, { socketPath, timeout: 25 }), false);
  assert.equal(calls, 10);
});
