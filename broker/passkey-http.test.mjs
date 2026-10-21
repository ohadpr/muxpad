import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { handler } from './http.mjs';
import { passkeyAdminHandler } from './passkey-http.mjs';
test('inline mode exposes no old paired/member/passkey endpoints, cookies or public admin confirmation', async () => {
  const calls = [];
  const config = {
    approvalMode: 'passkey-inline',
    authMode: 'paired',
    transport: 'tsnet',
    origin: 'https://broker.test',
    passkeyOrigin: 'https://muxpad.test',
    passkeyRPID: 'muxpad.test',
    passkeyGeneration: '11111111-1111-4111-8111-111111111111',
  };
  const broker = {
    config,
    listGrants: () => [],
    passkeys: {
      status: () => ({ mode: 'passkey-inline', registered: true }),
      options: async (b) => {
        calls.push(b);
        return { options: { challenge: 'public' } };
      },
    },
    create: async () => ({ state: 'pending' }),
  };
  const server = createServer(handler(broker, config.origin, { config }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of [
      '/human/pair',
      '/human/decision',
      '/human/node/session',
      '/device/session',
      '/registration/options',
      '/registration/verify',
      '/requests/11111111-1111-4111-8111-111111111111/options',
      '/confirm-enrollment',
    ]) {
      const r = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'old-authority' },
        body: '{}',
      });
      assert.equal(r.status, 404, path);
      assert.equal(r.headers.get('set-cookie'), null);
    }
    for (const path of [
      '/enroll',
      '/review',
      '/client.js',
      '/human/session',
      '/approve/11111111-1111-4111-8111-111111111111',
    ])
      assert.equal((await fetch(url + path)).status, 404, path);
    const r = await fetch(url + '/inline/status');
    assert.equal((await r.json()).mode, 'passkey-inline');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(calls.length, 0);
    assert.equal(
      (await fetch(url + '/health').then((r) => r.json())).version,
      'inchat-slack-capabilities-v2-2026-10-20',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test('private admin handler binds only explicit operations; no generic state writes', async () => {
  const calls = [];
  const server = createServer(
    passkeyAdminHandler({
      passkeys: {
        confirmEnrollment: (b) => {
          calls.push(b);
          return { registered: true };
        },
      },
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (
        await fetch(url + '/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      400,
    );
    assert.equal(calls.length, 0);
    const r = await fetch(url + '/confirm-enrollment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateID: 'public-candidate' }),
    });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
