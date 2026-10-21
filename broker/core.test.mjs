import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { Broker } from './core.mjs';
const hash = (b) => createHash('sha256').update(b).digest();
const origin = 'https://broker.test';
const rpID = 'broker.test';
function fixture(config = {}) {
  let time = 1000;
  const calls = [];
  const saves = [];
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
  const credentialID = randomBytes(32);
  const id = credentialID.toString('base64url');
  const state = { credential: { id, publicKey: cose.toString('base64url'), counter: 0 } };
  const broker = new Broker({
    config: { origin, rpID, bootstrapHash: hash('s'.repeat(40)).toString('base64url'), ...config },
    state,
    save: (s) => saves.push(structuredClone(s)),
    slack: async (a, p) => {
      calls.push([a, p]);
      return { channel: 'C123', ts: '123.45' };
    },
    now: () => time,
  });
  function assertion(
    options,
    {
      flags = 5,
      sourceOrigin = origin,
      challenge = options.challenge,
      count = 1,
      key = privateKey,
    } = {},
  ) {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: sourceOrigin }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(count);
    const auth = Buffer.concat([hash(rpID), Buffer.from([flags]), counter]);
    const signature = sign('sha256', Buffer.concat([auth, hash(clientData)]), key);
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: auth.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }
  function registration(options) {
    const client = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }),
    );
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credentialID.length);
    const auth = Buffer.concat([
      hash(rpID),
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      len,
      credentialID,
      cose,
    ]);
    const attestation = encodeCBOR(
      new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(auth)],
      ]),
    );
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: client.toString('base64url'),
        attestationObject: Buffer.from(attestation).toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }
  return {
    broker,
    calls,
    saves,
    state,
    assertion,
    registration,
    advance: (ms) => {
      time += ms;
    },
  };
}
const request = (f) =>
  f.broker.create({ action: 'slack.post', payload: { ref: 'C123', text: 'Hello' } });
test('a real signed, user-verified assertion executes the exact displayed payload once', async () => {
  const f = fixture();
  const r = await request(f);
  assert.equal(f.calls.length, 0);
  assert.equal(r.payload.text, '🤖 Hello');
  const options = await f.broker.options(r.id, 'approve');
  const response = f.assertion(options);
  assert.equal((await f.broker.decide(r.id, response)).state, 'complete');
  assert.deepEqual(f.calls, [['slack.post', { channel: 'C123', text: '🤖 Hello' }]]);
  assert.equal(f.saves[0].lastDecision.id, r.id);
  await assert.rejects(f.broker.decide(r.id, response));
  assert.equal(f.calls.length, 1);
});
test('concurrent assertion replay cannot execute twice', async () => {
  const f = fixture();
  const r = await request(f);
  const options = await f.broker.options(r.id, 'approve');
  await Promise.allSettled([
    f.broker.decide(r.id, f.assertion(options)),
    f.broker.decide(r.id, f.assertion(options)),
  ]);
  assert.equal(f.calls.length, 1);
});
for (const [name, modifications] of [
  ['wrong origin', { sourceOrigin: 'https://evil.test' }],
  ['wrong challenge', { challenge: 'evil' }],
  ['no user verification', { flags: 1 }],
  [
    'wrong signing key',
    { key: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey },
  ],
]) {
  test(`rejects ${name} with real signature verification`, async () => {
    const f = fixture();
    const r = await request(f);
    const options = await f.broker.options(r.id, 'approve');
    assert.equal(
      (await f.broker.decide(r.id, f.assertion(options, modifications))).state,
      'failed',
    );
    assert.equal(f.calls.length, 0);
  });
}
test('challenge cannot approve a different action', async () => {
  const f = fixture();
  const first = await request(f);
  const second = await request(f);
  const options = await f.broker.options(first.id, 'approve');
  await f.broker.options(second.id, 'approve');
  assert.equal((await f.broker.decide(second.id, f.assertion(options))).state, 'failed');
  assert.equal(f.calls.length, 0);
});
test('reject decision, expiry and failed persistence never execute Slack', async () => {
  const f = fixture();
  let r = await request(f);
  let options = await f.broker.options(r.id, 'reject');
  assert.equal((await f.broker.decide(r.id, f.assertion(options))).state, 'rejected');
  r = await request(f);
  options = await f.broker.options(r.id, 'approve');
  f.advance(300_001);
  await assert.rejects(f.broker.decide(r.id, f.assertion(options)));
  assert.equal(f.calls.length, 0);
  r = await request(f);
  options = await f.broker.options(r.id, 'approve');
  f.broker.save = () => {
    throw Error('disk full');
  };
  assert.equal((await f.broker.decide(r.id, f.assertion(options))).state, 'failed');
  assert.equal(f.calls.length, 0);
});
test('reads need approval by default and policy blocks out-of-scope requests', async () => {
  const f = fixture({ channels: ['C123'] });
  const r = await f.broker.create({ action: 'slack.read', payload: { ref: 'C123' } });
  assert.equal(r.state, 'pending');
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    f.broker.create({ action: 'slack.post', payload: { ref: 'C456', text: 'no' } }),
  );
  await assert.rejects(f.broker.create({ action: 'slack.search', payload: { query: 'all' } }));
  await assert.rejects(f.broker.create({ action: 'arbitrary.fetch', payload: {} }));
  await assert.rejects(
    f.broker.create({ action: 'slack.post', payload: { ref: '#mutable-name', text: 'no' } }),
  );
});
test('root policy can explicitly auto-allow reads but never writes', async () => {
  const f = fixture({ autoRead: true });
  assert.equal(
    (await f.broker.create({ action: 'slack.channels', payload: {} })).state,
    'complete',
  );
  assert.equal((await request(f)).state, 'pending');
  assert.equal(f.calls.length, 1);
});
test('real registration needs bootstrap secret and enrollment closes after first passkey', async () => {
  const f = fixture();
  delete f.state.credential;
  await assert.rejects(f.broker.registerOptions('wrong'));
  const options = await f.broker.registerOptions('s'.repeat(40));
  assert.deepEqual(await f.broker.register('s'.repeat(40), f.registration(options)), {
    registered: true,
  });
  await assert.rejects(f.broker.registerOptions('s'.repeat(40)));
  const r = await request(f);
  const auth = await f.broker.options(r.id, 'approve');
  assert.equal((await f.broker.decide(r.id, f.assertion(auth))).state, 'complete');
});
test('restart loses pending actions instead of replaying them', async () => {
  const f = fixture();
  const r = await request(f);
  const replacement = fixture();
  assert.throws(() => replacement.broker.view(r.id));
});
