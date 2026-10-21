import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceClient } from './device-client.mjs';
const forbiddenStore = {
  get() {
    throw Error('must not read browser keys');
  },
  put() {
    throw Error('must not register browser keys');
  },
  clear() {
    throw Error('must not touch legacy keys');
  },
};
const session = { authMode: 'tailnet-peer', csrf: 'csrf', expires: 123456, config: {} };
const pausedError = () =>
  Object.assign(Error('signed out'), {
    status: 401,
    data: { authMode: 'tailnet-peer', resumeRequired: true, resumeChallenge: 'challenge' },
  });
for (const locked of [true, false])
  test(`peer bootstrap needs no IndexedDB, key, PIN or browser locks (${locked})`, async () => {
    const paths = [];
    const client = createDeviceClient({
      store: forbiddenStore,
      subtle: locked ? {} : null,
      locks: locked ? { request: (_a, _b, work) => work() } : null,
      call: async (path) => {
        paths.push(path);
        return session;
      },
    });
    assert.equal((await client.ensure()).durable, true);
    assert.deepEqual(paths, ['/human/session']);
  });
test('peer logout indication never falls through to legacy key renewal or automatic resume', async () => {
  const paths = [];
  const client = createDeviceClient({
    store: forbiddenStore,
    subtle: {},
    locks: { request: (_a, _b, work) => work() },
    call: async (path) => {
      paths.push(path);
      throw pausedError();
    },
  });
  await assert.rejects(client.ensure(), /signed out/);
  assert.deepEqual(paths, ['/human/session']);
});
test('explicit resume consumes the protected peer-bound challenge once; uncertain mutation is never replayed', async () => {
  const calls = [];
  let resumed = false;
  const client = createDeviceClient({
    store: forbiddenStore,
    subtle: null,
    locks: null,
    call: async (path, body) => {
      calls.push([path, body]);
      if (path === '/human/node/challenge') return { challenge: 'challenge' };
      if (path === '/human/session') {
        if (!resumed) throw pausedError();
        return session;
      }
      assert.equal(path, '/human/node/resume');
      assert.deepEqual(body, { challenge: 'challenge' });
      resumed = true;
      return { resumed: true };
    },
  });
  assert.equal((await client.resume()).authMode, 'tailnet-peer');
  assert.deepEqual(
    calls.map(([p]) => p),
    ['/human/node/challenge', '/human/node/resume', '/human/session'],
  );
  let writes = 0;
  const failed = createDeviceClient({
    call: async (path) => {
      if (path === '/human/node/challenge') return { challenge: 'challenge' };
      writes++;
      throw Error('uncertain');
    },
  });
  await assert.rejects(failed.resume(), /uncertain/);
  assert.equal(writes, 1);
});
test('peer logout and device revoke use node-bound session/CSRF and preserve legacy stored keys', async () => {
  const calls = [];
  const client = createDeviceClient({
    store: forbiddenStore,
    locks: null,
    call: async (path, body, csrf) => {
      calls.push([path, body, csrf]);
      return session;
    },
  });
  await client.revoke();
  await client.revokeNode();
  assert.deepEqual(calls, [
    ['/human/session', undefined, undefined],
    ['/human/logout', {}, 'csrf'],
    ['/human/session', undefined, undefined],
    ['/human/node/revoke', {}, 'csrf'],
  ]);
});

test('automatic peer bootstrap uses one exact-origin JSON POST after read-only 401 and does not replay uncertain issuance', async () => {
  const calls = [];
  let issued = false;
  const client = createDeviceClient({
    store: forbiddenStore,
    subtle: null,
    locks: null,
    call: async (path, body) => {
      calls.push([path, body]);
      if (path === '/human/node/session') {
        assert.deepEqual(body, {});
        issued = true;
        return {};
      }
      if (!issued)
        throw Object.assign(Error('bootstrap'), {
          status: 401,
          data: { authMode: 'tailnet-peer', bootstrap: true },
        });
      return session;
    },
  });
  assert.equal((await client.ensure()).authMode, 'tailnet-peer');
  assert.deepEqual(
    calls.map(([p]) => p),
    ['/human/session', '/human/node/session', '/human/session'],
  );
  let writes = 0;
  const failed = createDeviceClient({
    subtle: null,
    locks: null,
    call: async (path) => {
      if (path === '/human/session')
        throw Object.assign(Error('bootstrap'), {
          status: 401,
          data: { authMode: 'tailnet-peer', bootstrap: true },
        });
      writes++;
      throw Error('lost response');
    },
  });
  await assert.rejects(failed.ensure(), /lost response/);
  assert.equal(writes, 1);
});
