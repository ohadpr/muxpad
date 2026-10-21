import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { handler } from './http.mjs';
test('HTTP boundary rejects cross-origin calls, never exposes an execution endpoint, and frames cannot embed approvals', async () => {
  const calls = [];
  const server = createServer(
    handler(
      {
        create: async (input) => {
          calls.push(input);
          return { state: 'pending' };
        },
      },
      'https://broker.test',
    ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${url}/requests`, {
      method: 'POST',
      headers: { Origin: 'https://evil.test', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 403);
    assert.equal(calls.length, 0);
    r = await fetch(`${url}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 404);
    r = await fetch(`${url}/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'slack.post', payload: { text: 'read exactly' } }),
    });
    assert.equal(r.status, 202);
    assert.equal(calls.length, 1);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(`${url}/enroll`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    r = await fetch(`${url}/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    assert.equal(r.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
