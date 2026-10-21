import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { Broker } from './core.mjs';
const hash = (v) => createHash('sha256').update(v).digest();
function fixture() {
  let wall = 1000,
    elapsed = 1000,
    count = 0,
    failSave = false,
    saveHook = () => {},
    slackHook = async () => {};
  const calls = [],
    saves = [];
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.from(
    encodeCBOR(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
      ]),
    ),
  );
  const id = randomBytes(32).toString('base64url'),
    origin = 'https://muxpad.test',
    rpID = 'muxpad.test',
    generation = '11111111-1111-4111-8111-111111111111',
    secret = 's'.repeat(40);
  const state = {
    inlinePasskey: {
      id,
      publicKey: cose.toString('base64url'),
      counter: 0,
      generation,
      revoked: false,
    },
  };
  const config = {
    origin: 'https://broker.test',
    rpID: 'broker.test',
    transport: 'tsnet',
    authMode: 'paired',
    approvalMode: 'passkey-inline',
    passkeyOrigin: origin,
    passkeyRPID: rpID,
    passkeyGeneration: generation,
    bootstrapHash: hash(secret).toString('base64url'),
    passkeyEnrollmentExpires: 301000,
    teamID: 'T1',
  };
  const broker = new Broker({
    config,
    state,
    now: () => wall,
    elapsed: () => elapsed,
    save: (s) => {
      saveHook();
      if (failSave) throw Error('PRIVATE disk failure');
      saves.push(structuredClone(s));
    },
    slack: async (a, p) => {
      calls.push([a, p]);
      await slackHook();
      return { ok: true };
    },
  });
  function assertion(options, { flags = 1, sourceOrigin = origin, key = privateKey } = {}) {
    const client = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: sourceOrigin }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++count);
    const auth = Buffer.concat([hash(rpID), Buffer.from([flags]), counter]);
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: client.toString('base64url'),
        authenticatorData: auth.toString('base64url'),
        signature: sign('sha256', Buffer.concat([auth, hash(client)]), key).toString('base64url'),
        userHandle: null,
      },
      clientExtensionResults: {},
    };
  }
  function registration(options, { flags = 0x41 } = {}) {
    const client = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }),
    );
    const len = Buffer.alloc(2);
    len.writeUInt16BE(Buffer.from(id, 'base64url').length);
    const auth = Buffer.concat([
      hash(rpID),
      Buffer.from([flags]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      len,
      Buffer.from(id, 'base64url'),
      cose,
    ]);
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: client.toString('base64url'),
        attestationObject: Buffer.from(
          encodeCBOR(
            new Map([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', new Uint8Array(auth)],
            ]),
          ),
        ).toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: { credProps: { rk: true } },
    };
  }
  const request = (action = 'slack.post', payload = { ref: 'C123', text: 'exact message' }) =>
    broker.create({ action, payload });
  const options = (r, duration = 'once', decision = 'approve') =>
    broker.passkeys.options({
      id: r.id,
      fingerprint: r.fingerprint,
      decision,
      duration,
      ...(duration !== 'once' ? { scope: 'slack-team-all-v2' } : {}),
    });
  const approve = async (r, duration = 'once', decision = 'approve') => {
    const o = await options(r, duration, decision);
    return broker.passkeys.verify({ ceremonyID: o.ceremonyID, response: assertion(o.options) });
  };
  return {
    broker,
    expectedFingerprint: hash(publicKey.export({ format: 'der', type: 'spki' })).toString(
      'base64url',
    ),
    state,
    config,
    calls,
    saves,
    request,
    options,
    approve,
    assertion,
    registration,
    secret,
    setFail(v) {
      failSave = v;
    },
    saveHook(v) {
      saveHook = v;
    },
    slackHook(v) {
      slackHook = v;
    },
    advance(v) {
      wall += v;
      elapsed += v;
    },
    elapsed(v) {
      elapsed += v;
    },
  };
}
for (const flags of [1, 5])
  test('fresh actual signed presence assertion flags=' +
    flags +
    ' binds app RP and exact request, once executes only once without grant', async () => {
    const f = fixture(),
      r = await f.request();
    const o = await f.options(r);
    assert.equal(o.options.userVerification, 'discouraged');
    const body = { ceremonyID: o.ceremonyID, response: f.assertion(o.options, { flags }) };
    assert.equal((await f.broker.passkeys.verify(body)).state, 'complete');
    assert.equal(f.calls.length, 1);
    assert.equal(f.broker.listGrants().length, 0);
    await assert.rejects(f.broker.passkeys.verify(body));
    assert.equal(f.calls.length, 1);
  });
for (const [label, opts] of [
  ['no UP', { flags: 0 }],
  ['UV without UP', { flags: 4 }],
  ['wrong app origin', { sourceOrigin: 'https://broker.test' }],
])
  test(label + ' never dispatches', async () => {
    const f = fixture(),
      r = await f.request(),
      o = await f.options(r);
    assert.equal(
      (
        await f.broker.passkeys.verify({
          ceremonyID: o.ceremonyID,
          response: f.assertion(o.options, opts),
        })
      ).state,
      'failed',
    );
    assert.equal(f.calls.length, 0);
  });
test('timed broad grant crosses all five actions and destinations but never sweeps queued requests', async () => {
  const f = fixture(),
    r = await f.request(),
    queued = await f.request('slack.read', { ref: 'C999' });
  assert.equal((await f.approve(r, '10m')).state, 'complete');
  assert.equal(f.broker.get(queued.id).state, 'pending');
  for (const [a, p] of [
    ['slack.channels', {}],
    ['slack.read', { ref: 'C456' }],
    ['slack.search', { query: 'team query' }],
    ['slack.unpost', { ref: 'C789', ts: '123.45' }],
    ['slack.post', { ref: 'C555', text: 'second' }],
  ])
    assert.equal((await f.request(a, p)).state, 'complete');
  assert.equal(f.calls.length, 6);
  f.config.teamID = 'OTHER';
  assert.equal((await f.request()).state, 'pending');
  await assert.rejects(f.request('slack.future', {}));
});
test('scope and duration tampering rejected before consume; challenge duration immutable', async () => {
  const f = fixture(),
    r = await f.request();
  await assert.rejects(
    f.broker.passkeys.options({
      id: r.id,
      fingerprint: r.fingerprint,
      decision: 'approve',
      duration: '10m',
    }),
  );
  assert.equal(f.broker.get(r.id).state, 'pending');
  const o = await f.options(r, '10m');
  await assert.rejects(
    f.broker.passkeys.verify({
      ceremonyID: o.ceremonyID,
      response: f.assertion(o.options),
      duration: '1d',
    }),
  );
  assert.equal(f.calls.length, 0);
});
test('concurrent manual assertions cannot dispatch twice', async () => {
  const f = fixture(),
    r = await f.request(),
    a = await f.options(r),
    b = await f.options(r);
  const out = await Promise.allSettled([
    f.broker.passkeys.verify({ ceremonyID: a.ceremonyID, response: f.assertion(a.options) }),
    f.broker.passkeys.verify({ ceremonyID: b.ceremonyID, response: f.assertion(b.options) }),
  ]);
  assert.equal(f.calls.length, 1);
  assert.ok(out.some((x) => x.status === 'rejected'));
});
test('revoke during crypto or audit prevents dispatch; audit failure latches authority', async () => {
  const f = fixture(),
    r = await f.request(),
    o = await f.options(r);
  f.broker.revokeGrants('all');
  await assert.rejects(
    f.broker.passkeys.verify({ ceremonyID: o.ceremonyID, response: f.assertion(o.options) }),
  );
  assert.equal(f.calls.length, 0);
  const n = await f.request();
  f.setFail(true);
  await f.approve(n);
  assert.equal(f.calls.length, 0);
  f.setFail(false);
  await assert.rejects(f.request());
});
test('expiry wall/elapsed and revoke during Slack suppress delayed grant activation; no retry', async () => {
  const f = fixture(),
    r = await f.request(),
    o = await f.options(r);
  f.elapsed(120001);
  await assert.rejects(
    f.broker.passkeys.verify({ ceremonyID: o.ceremonyID, response: f.assertion(o.options) }),
  );
  assert.equal(f.calls.length, 0);
  const g = fixture(),
    n = await g.request();
  g.slackHook(async () => g.broker.passkeys.revoke());
  const result = await g.approve(n, '1h');
  assert.equal(result.state, 'complete');
  assert.ok(result.grantWarning);
  assert.equal(g.broker.listGrants().length, 0);
  assert.equal(g.calls.length, 1);
});
test('new mode never accepts legacy registration/options/session decision or autoRead', async () => {
  const f = fixture();
  f.config.autoRead = true;
  const r = await f.request('slack.channels', {});
  assert.equal(r.state, 'pending');
  await assert.rejects(f.broker.options(r.id, 'approve'));
  await assert.rejects(f.broker.decide(r.id, {}));
  await assert.rejects(f.broker.decideSession(r.id, r.fingerprint, 'approve'));
  await assert.rejects(f.broker.registerOptions(f.secret));
  assert.equal(f.calls.length, 0);
});
test('registration consumes cap, creates no authority until exact private root confirmation', async () => {
  const f = fixture();
  delete f.state.inlinePasskey;
  const o = await f.broker.passkeys.registrationOptions({ secret: f.secret });
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: f.secret }));
  const result = await f.broker.passkeys.registrationVerify({ response: f.registration(o) });
  assert.equal(result.registered, false);
  assert.equal(result.candidate.fingerprint, f.expectedFingerprint);
  await assert.rejects(f.request());
  const c = result.candidate;
  assert.throws(() => f.broker.passkeys.confirmEnrollment({ ...c, credentialID: 'wrong' }));
  const { expires, ...confirmation } = c;
  assert.equal(f.broker.passkeys.confirmEnrollment(confirmation).registered, true);
  assert.equal((await f.request()).state, 'pending');
  assert.equal(f.broker.listGrants().length, 0);
  assert.throws(() => f.broker.passkeys.confirmEnrollment(confirmation));
});
test('Settings timed-permission revocation requires fresh signed presence management purpose; cannot replay as approval', async () => {
  const f = fixture(),
    r = await f.request();
  await f.approve(r, '1h');
  assert.equal(f.broker.listGrants().length, 1);
  const c = await f.broker.passkeys.managementOptions({ purpose: 'revoke-timed-permissions' });
  const response = f.assertion(c.options);
  assert.equal(
    (await f.broker.passkeys.managementVerify({ ceremonyID: c.ceremonyID, response })).grants
      .length,
    0,
  );
  await assert.rejects(f.broker.passkeys.managementVerify({ ceremonyID: c.ceremonyID, response }));
  assert.equal(f.calls.length, 1);
  const d = await f.broker.passkeys.managementOptions({ purpose: 'revoke-timed-permissions' });
  await assert.rejects(
    f.broker.passkeys.verify({ ceremonyID: d.ceremonyID, response: f.assertion(d.options) }),
  );
  assert.equal(f.calls.length, 1);
});
test('failed admin confirmation persistence never activates credential, cannot recover by retrying old capability', async () => {
  const f = fixture();
  delete f.state.inlinePasskey;
  const options = await f.broker.passkeys.registrationOptions({ secret: f.secret });
  const { candidate } = await f.broker.passkeys.registrationVerify({
    response: f.registration(options),
  });
  const { expires, ...confirmation } = candidate;
  f.setFail(true);
  assert.throws(() => f.broker.passkeys.confirmEnrollment(confirmation));
  assert.equal(f.state.inlinePasskey, undefined);
  f.setFail(false);
  assert.throws(() => f.broker.passkeys.confirmEnrollment(confirmation));
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: f.secret }));
});
test('challenge commits exact relay-visible payload, duration, scope and purpose', async () => {
  const f = fixture(),
    r = await f.request(),
    o = await f.options(r, '1h');
  const { canonicalIntent } = await import('./passkey-approval.mjs');
  assert.equal(o.options.challenge, hash(canonicalIntent(o.intent)).toString('base64url'));
  assert.equal(o.intent.duration, '1h');
  assert.equal(o.intent.scope, 'slack-team-all-v2');
  assert.equal(o.intent.purpose, 'slack-decision');
  assert.deepEqual(o.intent.payload, r.payload);
  assert.equal(
    canonicalIntent({ b: 'x', a: { z: 2, y: [1, true] } }),
    '{"a":{"y":[1,true],"z":2},"b":"x"}',
  );
});
test('enrollment fingerprint rejects algorithm mismatch and malformed verified key bytes', async () => {
  const { publicKeyFingerprint } = await import('./passkey-approval.mjs');
  const { decodeCredentialPublicKey } = await import('@simplewebauthn/server/helpers');
  const f = fixture();
  const c = decodeCredentialPublicKey(Buffer.from(f.state.inlinePasskey.publicKey, 'base64url'));
  c.set(3, -257);
  assert.throws(() => publicKeyFingerprint(Buffer.from(encodeCBOR(c))), /ES256/);
  assert.throws(() => publicKeyFingerprint(Buffer.from([1])));
});
test('actual protected Unix admin flow confirms exact candidate and can verify lost-response completion without state-file overwrite', async () => {
  const { createServer, request } = await import('node:http');
  const { mkdtempSync, chmodSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { listenPasskeyAdmin } = await import('./passkey-admin-socket.mjs');
  const { passkeyAdminHandler } = await import('./passkey-http.mjs');
  const f = fixture();
  delete f.state.inlinePasskey;
  const o = await f.broker.passkeys.registrationOptions({ secret: f.secret });
  const { candidate } = await f.broker.passkeys.registrationVerify({ response: f.registration(o) });
  const { expires, ...body } = candidate;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'pki-'));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, 'a');
  const server = createServer(passkeyAdminHandler(f.broker));
  const call = (path, value) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path,
          method: value ? 'POST' : 'GET',
          headers: value ? { 'content-type': 'application/json' } : {},
        },
        (res) => {
          let raw = '';
          res.on('data', (s) => (raw += s));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        },
      );
      req.on('error', reject);
      req.end(value ? JSON.stringify(value) : undefined);
    });
  try {
    await listenPasskeyAdmin(server, socketPath, { inspectACL: false });
    assert.equal(
      (await call('/confirm-enrollment', { ...body, fingerprint: 'wrong' })).status,
      400,
    );
    assert.equal(f.broker.passkeys.credential(), null);
    assert.equal((await call('/confirm-enrollment', body)).status, 200);
    const result = await call('/status');
    assert.equal(result.status, 200);
    assert.equal(result.body.fingerprint, f.expectedFingerprint);
    assert.equal(result.body.registered, true);
    assert.deepEqual(Object.keys(result.body).sort(), [
      'credentialID',
      'enrollment',
      'fingerprint',
      'generation',
      'origin',
      'registered',
      'rpID',
      'storageFault',
    ]);
    assert.equal((await call('/confirm-enrollment', body)).status, 400);
    assert.equal((await call('/status')).body.registered, true);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

function leaseInput(f, operationID = '22222222-2222-4222-8222-222222222222') {
  const e = f.broker.passkeys.enrollmentState();
  return {
    operationID,
    secretHash: hash('replacement-secret').toString('base64url'),
    previousLeaseID: e.leaseID,
    candidateID: e.candidateID,
    candidateFingerprint: e.candidateFingerprint,
    rpID: f.config.passkeyRPID,
    origin: f.config.passkeyOrigin,
    generation: f.config.passkeyGeneration,
  };
}
test('private exact lease replaces cancelled setup, consumes once and disables original capability', async () => {
  const f = fixture();
  delete f.state.inlinePasskey;
  await f.broker.passkeys.registrationOptions({ secret: f.secret });
  const body = leaseInput(f);
  const receipt = f.broker.passkeys.beginEnrollment(body);
  assert.equal(receipt.operationID, body.operationID);
  assert.deepEqual(f.broker.passkeys.beginEnrollment(body), receipt); // lost reply, no lifetime extension
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: f.secret }));
  const options = await f.broker.passkeys.registrationOptions({ secret: 'replacement-secret' });
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: 'replacement-secret' }));
  const c = await f.broker.passkeys.registrationVerify({ response: f.registration(options) });
  assert.equal(c.registered, false);
  assert.throws(() =>
    f.broker.passkeys.beginEnrollment({
      ...body,
      operationID: '33333333-3333-4333-8333-333333333333',
    }),
  );
});
test('lease expiry/restart never renews and stale replacement or changed operation is refused', async () => {
  const f = fixture();
  delete f.state.inlinePasskey;
  const body = leaseInput(f);
  f.broker.passkeys.beginEnrollment(body);
  assert.throws(() => f.broker.passkeys.beginEnrollment({ ...body, secretHash: 'B'.repeat(43) }));
  f.advance(600001);
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: 'replacement-secret' }));
  const next = leaseInput(f, '33333333-3333-4333-8333-333333333333');
  f.broker.passkeys.beginEnrollment(next);
  f.broker.passkeys.boot = 'different-boot';
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: 'replacement-secret' }));
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: f.secret }));
});
test('lease save uncertainty latches off instead of reusing old capability', async () => {
  const f = fixture();
  delete f.state.inlinePasskey;
  f.setFail(true);
  assert.throws(() => f.broker.passkeys.beginEnrollment(leaseInput(f)), /uncertain/);
  f.setFail(false);
  await assert.rejects(f.broker.passkeys.registrationOptions({ secret: f.secret }));
  assert.throws(() => f.broker.passkeys.beginEnrollment(leaseInput(f)));
});

test('enrollment may omit UV but still rejects absent presence without activating a key', async () => {
  const f = fixture();
  delete f.state.inlinePasskey;
  const options = await f.broker.passkeys.registrationOptions({ secret: f.secret });
  assert.equal(options.authenticatorSelection.userVerification, 'discouraged');
  await assert.rejects(
    f.broker.passkeys.registrationVerify({ response: f.registration(options, { flags: 0x40 }) }),
  );
  assert.equal(f.broker.passkeys.credential(), null);
  assert.equal(f.state.inlineCandidate, undefined);
});
