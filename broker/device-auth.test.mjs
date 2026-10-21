import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { DeviceAuth } from './device-auth.mjs';
import { HumanSessions, SESSION_COOKIE } from './human-session.mjs';

function key() {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kty, crv, x, y } = k.publicKey.export({ format: 'jwk' });
  return { ...k, jwk: { kty, crv, x, y } };
}
function fixture() {
  let wall = 1000;
  let elapsed = 0;
  const secret = 'test-only-pairing-secret';
  const state = {};
  const config = {
    approvalMode: 'session',
    origin: 'https://secure.example.test',
    bootstrapHash: createHash('sha256').update(secret).digest('base64url'),
  };
  const snapshots = [];
  const save = (value) => snapshots.push(structuredClone(value));
  const sessions = new HumanSessions({ config, state, save, now: () => wall });
  const pair = sessions.pair(secret);
  const cookie = `${SESSION_COOKIE}=${pair.token}`;
  const csrf = sessions.authenticate(cookie).csrf;
  const create = () =>
    new DeviceAuth({
      config,
      state,
      save: (value) => sessions.save(value),
      sessions,
      now: () => wall,
      elapsed: () => elapsed,
    });
  const device = create();
  const signing = key();
  const register = () => device.register(cookie, csrf, signing.jwk).deviceID;
  const proof = (challenge, k = signing) =>
    sign('sha256', Buffer.from(challenge.message), {
      key: k.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
  return {
    state,
    config,
    sessions,
    device,
    snapshots,
    cookie,
    csrf,
    signing,
    register,
    proof,
    create,
    advance: (ms) => {
      wall += ms;
      elapsed += ms;
    },
    advanceWall: (ms) => {
      wall += ms;
    },
    advanceElapsed: (ms) => {
      elapsed += ms;
    },
  };
}

test('migration preserves current session and registers a canonical public key idempotently', () => {
  const f = fixture();
  const id = f.register();
  assert.ok(f.sessions.authorize(f.cookie, f.csrf));
  assert.equal(
    f.device.register(f.cookie, f.csrf, {
      y: f.signing.jwk.y,
      x: f.signing.jwk.x,
      crv: 'P-256',
      kty: 'EC',
    }).deviceID,
    id,
  );
  assert.equal(f.state.humanDevices.length, 1);
  assert.equal(f.state.humanSessions[0].deviceID, id);
  assert.equal(f.state.deviceEnrollmentComplete, true);
  assert.equal(JSON.stringify(f.state).includes('PRIVATE KEY'), false);
  assert.throws(() => f.device.register(f.cookie, f.csrf, key().jwk), /closed/);
});

test('device registration requires the paired cookie and CSRF and accepts public P-256 keys only', () => {
  const f = fixture();
  assert.throws(() => f.device.register('', f.csrf, f.signing.jwk));
  assert.throws(() => f.device.register(f.cookie, 'forged', f.signing.jwk));
  for (const jwk of [
    null,
    {},
    { ...f.signing.jwk, d: 'private' },
    { ...f.signing.jwk, x: 'short' },
    { ...f.signing.jwk, crv: 'P-384' },
  ])
    assert.throws(() => f.device.register(f.cookie, f.csrf, jwk));
  assert.equal(f.state.deviceEnrollmentComplete, undefined);
});

test('durable proof silently restores an expired session without pairing and survives broker restart', () => {
  const f = fixture();
  const id = f.register();
  f.advance(31 * 86400_000);
  assert.equal(f.sessions.authenticate(f.cookie), null);
  const restarted = f.create();
  const c = restarted.challenge(id);
  const issued = restarted.renew(id, c.challengeID, f.proof(c));
  assert.ok(f.sessions.authenticate(`${SESSION_COOKIE}=${issued.token}`));
  assert.throws(() => restarted.renew(id, c.challengeID, f.proof(c)));
  assert.throws(() => f.sessions.pair('test-only-pairing-secret'));
});

test('proofs bind origin, challenge, purpose and device and cannot be forged or replayed', () => {
  const f = fixture();
  const id = f.register();
  for (const mutate of [
    (c) => ({ ...c, message: c.message.replace('secure.example.test', 'attacker.test') }),
    (c) => ({ ...c, message: c.message.replace('session-renewal', 'approve-action') }),
    (c) => c,
  ]) {
    const c = f.device.challenge(id);
    const altered = mutate(c);
    assert.throws(() =>
      f.device.renew(id, c.challengeID, f.proof(altered, altered === c ? key() : f.signing)),
    );
    assert.throws(() => f.device.renew(id, c.challengeID, f.proof(c)));
  }
  const c = f.device.challenge(id);
  assert.throws(() => f.device.renew('wrong-device', c.challengeID, f.proof(c)));
  const next = f.device.challenge(id);
  assert.ok(f.device.renew(id, next.challengeID, f.proof(next)).token);
});

test('challenge expires at wall or elapsed boundary, including sparse observations during rollback/sleep', () => {
  for (const clock of ['wall', 'elapsed']) {
    const f = fixture();
    const id = f.register();
    const c = f.device.challenge(id);
    if (clock === 'wall') f.advanceWall(60_000);
    else {
      f.advanceWall(20_000);
      f.advanceElapsed(60_000);
    }
    assert.throws(() => f.device.renew(id, c.challengeID, f.proof(c)));
  }
  const f = fixture();
  const id = f.register();
  const c = f.device.challenge(id);
  assert.throws(() => f.create().renew(id, c.challengeID, f.proof(c)), /unavailable/);
});

test('revocation removes device and sessions, invalidates proofs and never reopens cookie enrollment', () => {
  const f = fixture();
  const id = f.register();
  const c = f.device.challenge(id);
  f.device.revoke(f.cookie, f.csrf);
  assert.equal(f.state.humanDevices.length, 0);
  assert.equal(f.sessions.authenticate(f.cookie), null);
  assert.equal(f.state.deviceEnrollmentComplete, true);
  assert.throws(() => f.device.renew(id, c.challengeID, f.proof(c)));
  // Even a second otherwise valid legacy session cannot reopen enrollment.
  f.state.humanSessions = [
    {
      tokenHash: createHash('sha256').update('a'.repeat(43)).digest('base64url'),
      csrf: 'legacy',
      expires: 999999,
    },
  ];
  assert.throws(
    () => f.device.register(`${SESSION_COOKIE}=${'a'.repeat(43)}`, 'legacy', key().jwk),
    /closed/,
  );
});

test('persistence failures publish no device or new bearer and consume uncertain proofs', () => {
  const f = fixture();
  const save = f.sessions.save;
  f.sessions.save = () => {
    throw Error('disk');
  };
  assert.throws(f.register);
  assert.equal(f.state.humanDevices, undefined);
  f.sessions.save = save;
  const id = f.register();
  const c = f.device.challenge(id);
  const previous = structuredClone(f.state);
  f.sessions.save = () => {
    throw Error('disk');
  };
  assert.throws(() => f.device.renew(id, c.challengeID, f.proof(c)));
  assert.deepEqual(f.state, previous);
  f.sessions.save = save;
  assert.throws(() => f.device.renew(id, c.challengeID, f.proof(c)));
});

test('slow persistence cannot return a cookie for an expired device proof', () => {
  const f = fixture();
  const id = f.register();
  const c = f.device.challenge(id);
  const previous = structuredClone(f.state);
  f.sessions.save = () => f.advanceElapsed(60_001);
  assert.throws(() => f.device.renew(id, c.challengeID, f.proof(c)), /expired/);
  assert.deepEqual(f.state, previous);
});

test('challenge capacity rejects excess requests without evicting an outstanding challenge', () => {
  const f = fixture();
  const id = f.register();
  const first = f.device.challenge(id);
  for (let i = 1; i < 8; i++) f.device.challenge(id);
  assert.throws(() => f.device.challenge(id));
  assert.ok(f.device.renew(id, first.challengeID, f.proof(first)).token);
});

test('session renewal invalidates the previous bearer rather than extending its authority', () => {
  const f = fixture();
  const id = f.register();
  const c = f.device.challenge(id);
  const issued = f.device.renew(id, c.challengeID, f.proof(c));
  assert.equal(f.sessions.authenticate(f.cookie), null);
  assert.ok(f.sessions.authenticate(`${SESSION_COOKIE}=${issued.token}`));
});
