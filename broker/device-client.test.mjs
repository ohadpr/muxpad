import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { DeviceAuth } from './device-auth.mjs';
import { createDeviceClient } from './device-client.mjs';
import { HumanSessions, SESSION_COOKIE } from './human-session.mjs';

function fixture() {
  let now = 1000;
  let elapsed = 0;
  let stored;
  const config = {
    approvalMode: 'session',
    origin: 'https://secure.example.test',
    bootstrapHash: createHash('sha256').update('pair').digest('base64url'),
  };
  const state = {};
  const saves = [];
  const sessions = new HumanSessions({
    config,
    state,
    now: () => now,
    save: (value) => saves.push(structuredClone(value)),
  });
  let cookie = `${SESSION_COOKIE}=${sessions.pair('pair').token}`;
  const devices = new DeviceAuth({
    config,
    state,
    sessions,
    save: sessions.save,
    now: () => now,
    elapsed: () => elapsed,
  });
  const calls = [];
  let loseRegistration = false;
  let loseRenewal = false;
  let poisonChallenge = false;
  let storageFailure = false;
  const store = {
    get: async () => (stored ? structuredClone(stored) : undefined),
    put: async (value) => {
      if (storageFailure) throw Error('storage');
      stored = structuredClone(value);
    },
    clear: async () => {
      stored = undefined;
    },
  };
  let previous = Promise.resolve();
  const locks = {
    request: (_name, _opts, work) => {
      const result = previous.then(work);
      previous = result.catch(() => {});
      return result;
    },
  };
  const call = async (path, body, csrf) => {
    calls.push(path);
    if (path === '/human/session') {
      const session = sessions.authenticate(cookie);
      if (!session) {
        const error = Error('not authenticated');
        error.status = 401;
        throw error;
      }
      return {
        csrf: session.csrf,
        expires: session.expires,
        deviceEnrolled: !!state.deviceEnrollmentComplete,
      };
    }
    if (path === '/human/device/register') {
      const result = devices.register(cookie, csrf, body.publicKey);
      if (loseRegistration) {
        loseRegistration = false;
        throw Error('response lost');
      }
      return result;
    }
    if (path === '/device/challenge') {
      const c = devices.challenge(body.deviceID);
      return poisonChallenge
        ? { ...c, message: c.message.replace(config.origin, 'https://attacker.test') }
        : c;
    }
    if (path === '/device/session') {
      const result = devices.renew(body.deviceID, body.challengeID, body.signature);
      // A lost response can also mean the browser never received Set-Cookie.
      if (loseRenewal) {
        loseRenewal = false;
        throw Error('response lost');
      }
      cookie = `${SESSION_COOKIE}=${result.token}`;
      return { renewed: true };
    }
    if (path === '/human/logout') {
      devices.revoke(cookie, csrf);
      cookie = '';
      return { revoked: true };
    }
    throw Error('unexpected path');
  };
  const client = () =>
    createDeviceClient({ store, subtle: webcrypto.subtle, locks, call, origin: config.origin });
  return {
    state,
    store,
    calls,
    sessions,
    client,
    record: () => stored,
    advance: (ms) => {
      now += ms;
      elapsed += ms;
    },
    failStorage: () => {
      storageFailure = true;
    },
    clearCookie: () => {
      cookie = '';
    },
    loseRegistration: () => {
      loseRegistration = true;
    },
    loseRenewal: () => {
      loseRenewal = true;
    },
    poisonChallenge: () => {
      poisonChallenge = true;
    },
  };
}

test('browser persists and proves a nonextractable key before registration, then silently renews after expiry/restart', async () => {
  const f = fixture();
  const first = await f.client().ensure();
  assert.equal(first.durable, true);
  assert.equal(f.record().privateKey.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('jwk', f.record().privateKey));
  f.advance(31 * 86400_000);
  assert.equal((await f.client().ensure()).durable, true);
  assert.equal(f.calls.filter((p) => p === '/device/session').length, 1);
  assert.equal(f.state.humanDevices.length, 1);
});

test('lost cookies are restored using the retained device key, without any PIN', async () => {
  const f = fixture();
  await f.client().ensure();
  f.clearCookie();
  assert.equal((await f.client().ensure()).durable, true);
  assert.equal(
    f.calls.some((p) => p === '/human/pair'),
    false,
  );
});

test('storage failure never registers an unusable key or claims durable pairing', async () => {
  const f = fixture();
  f.failStorage();
  assert.equal((await f.client().ensure()).durable, false);
  assert.equal(f.state.deviceEnrollmentComplete, undefined);
});

test('sibling tabs serialize migration and renewal and do not invalidate one another', async () => {
  const f = fixture();
  await Promise.all([f.client().ensure(), f.client().ensure()]);
  assert.equal(f.calls.filter((p) => p === '/human/device/register').length, 1);
  f.advance(31 * 86400_000);
  const result = await Promise.all([f.client().ensure(), f.client().ensure()]);
  assert.ok(result.every((s) => s.durable));
  assert.equal(f.calls.filter((p) => p === '/device/session').length, 1);
});

test('uncertain registration is retried idempotently with the same stored key', async () => {
  const f = fixture();
  f.loseRegistration();
  assert.equal((await f.client().ensure()).durable, false);
  const id = f.record().deviceID;
  assert.equal((await f.client().ensure()).durable, true);
  assert.equal(f.record().deviceID, id);
  assert.equal(f.state.humanDevices.length, 1);
});

test('uncertain renewal obtains a new challenge instead of replaying a consumed proof', async () => {
  const f = fixture();
  await f.client().ensure();
  f.advance(31 * 86400_000);
  f.loseRenewal();
  await assert.rejects(f.client().ensure(), /lost/);
  assert.equal((await f.client().ensure()).durable, true);
  assert.equal(f.calls.filter((p) => p === '/device/challenge').length, 2);
});

test('browser refuses to sign a challenge for another origin or purpose', async () => {
  const f = fixture();
  await f.client().ensure();
  f.clearCookie();
  f.poisonChallenge();
  await assert.rejects(f.client().ensure(), /Invalid device challenge/);
  assert.equal(f.calls.filter((p) => p === '/device/session').length, 0);
});

test('revocation serialized with renewal leaves no reusable key or session', async () => {
  const f = fixture();
  await f.client().ensure();
  f.advance(31 * 86400_000);
  await Promise.all([f.client().ensure(), f.client().revoke()]);
  assert.equal(f.state.humanDevices.length, 0);
  assert.equal(f.state.humanSessions.length, 0);
  assert.equal(f.record(), undefined);
  await assert.rejects(f.client().ensure());
  assert.equal(f.state.deviceEnrollmentComplete, true);
});

test('an invalid retained key preserves current session access without replacing the key', async () => {
  const f = fixture();
  await f.store.put({ deviceID: 'invalid', privateKey: { type: 'private' } });
  const result = await f.client().ensure();
  assert.equal(result.durable, false);
  assert.ok(result.csrf);
  assert.equal(f.record().deviceID, 'invalid');
  assert.equal(f.state.deviceEnrollmentComplete, undefined);
});
