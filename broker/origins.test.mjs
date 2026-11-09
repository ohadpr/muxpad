import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Origins, SKEW_MS, proofMessage, sign } from './origins.mjs';

/**
 * ORIGIN AS EVIDENCE.
 *
 * `origin` was a string the caller chose, so a grant bound to `trayo` was
 * spendable by anything on the mini willing to type it — which is why a
 * duration was only ever offered for `local`. These assertions are about the
 * two properties that change that: a proof can only be made by something
 * holding the remote key, and it is good exactly once.
 */
const KEY = 'k'.repeat(48);
const at = (t) => () => t;
const io = (keys) => ({
  readFileSync: (path) => {
    const name = String(path).split('/').pop().replace(/\.key$/, '');
    if (!(name in keys)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return keys[name];
  },
  assertProtectedPath: () => {},
});
const make = (keys = { trayo: KEY }, now = at(1_000_000)) =>
  new Origins({ dir: '/x', now, io: io(keys) });
const proof = (fields, key = KEY) => ({ ts: fields.ts, nonce: fields.nonce, sig: sign(key, fields) });
const req = (over = {}) => ({
  origin: 'trayo',
  action: 'slack.post',
  payload: { channel: 'C1', text: 'hi' },
  ts: 1_000_000,
  nonce: 'n'.repeat(24),
  ...over,
});

test('a proof minted with the origin’s key proves that origin', () => {
  const o = make();
  const f = req();
  assert.equal(o.verify({ ...f, proof: proof(f) }), true);
});

test('local needs no proof — believing it adds nothing', () => {
  assert.equal(make({}).verify({ origin: 'local', action: 'slack.post', payload: {} }), true);
});

test('no proof at all is a label, not a refusal', () => {
  // The request still goes to the human; it simply cannot earn a duration.
  assert.equal(make().verify({ ...req(), proof: undefined }), false);
});

test('the mini cannot mint one without the key', () => {
  const f = req();
  assert.equal(make().verify({ ...f, proof: proof(f, 'a different key entirely!!') }), false);
});

test('an origin with no key on this machine is never proven', () => {
  const f = req({ origin: 'laptop' });
  assert.equal(make().verify({ ...f, proof: proof(f) }), false);
});

test('a proof is good ONCE', () => {
  const o = make();
  const f = req();
  const p = proof(f);
  assert.equal(o.verify({ ...f, proof: p }), true);
  assert.equal(o.verify({ ...f, proof: p }), false, 'replayed');
});

test('a forged signature cannot evict an honest nonce from the replay memory', () => {
  const o = make();
  const f = req();
  assert.equal(o.verify({ ...f, proof: proof(f, 'wrong key wrong key wrong key!!') }), false);
  // The honest proof with that same nonce still works, which it would not if
  // the forgery had been remembered.
  assert.equal(o.verify({ ...f, proof: proof(f) }), true);
});

test('a proof cannot be moved onto another action or payload', () => {
  const o = make();
  const f = req();
  const p = proof(f);
  assert.equal(o.verify({ ...f, action: 'slack.unpost', proof: p }), false);
  assert.equal(o.verify({ ...f, payload: { channel: 'C1', text: 'different' }, proof: p }), false);
  assert.equal(o.verify({ ...f, origin: 'other', proof: p }), false);
});

test('key order in the payload does not change the bytes', () => {
  // An honest relay may re-serialise the payload on the way through; that
  // must not look like tampering.
  assert.equal(
    proofMessage({ origin: 'trayo', action: 'a', payload: { b: 1, a: 2 }, ts: 1, nonce: 'n' }),
    proofMessage({ origin: 'trayo', action: 'a', payload: { a: 2, b: 1 }, ts: 1, nonce: 'n' }),
  );
});

test('a stale or future-dated proof is refused', () => {
  const o = make();
  const old = req({ ts: 1_000_000 - SKEW_MS - 1 });
  assert.equal(o.verify({ ...old, proof: proof(old) }), false);
  const ahead = req({ ts: 1_000_000 + SKEW_MS + 1 });
  assert.equal(o.verify({ ...ahead, proof: proof(ahead) }), false);
});

test('a short key file is no key', () => {
  const f = req();
  assert.equal(make({ trayo: 'too-short' }).verify({ ...f, proof: proof(f, 'too-short') }), false);
});

test('an unreadable or unprotected key file is no key', () => {
  const o = new Origins({
    dir: '/x',
    now: at(1_000_000),
    io: {
      readFileSync: () => KEY,
      assertProtectedPath: () => {
        throw Error('Unprotected file or ancestor');
      },
    },
  });
  const f = req();
  assert.equal(o.verify({ ...f, proof: proof(f) }), false);
});

test('an origin name may not name a path', () => {
  const o = make({ trayo: KEY });
  for (const bad of ['../policy', 'a/b', '.', '', 'A'.repeat(40)])
    assert.equal(o.key(bad), null, bad);
});

test('the replay memory forgets, and is bounded', () => {
  let t = 1_000_000;
  const o = make({ trayo: KEY }, () => t);
  const first = req({ nonce: 'x'.repeat(24) });
  assert.equal(o.verify({ ...first, proof: proof(first) }), true);
  // Past the window the entry is dropped — and the proof is too old anyway,
  // so the forgetting can never resurrect one.
  t += SKEW_MS * 3;
  const late = req({ ts: t, nonce: 'x'.repeat(24) });
  assert.equal(o.verify({ ...late, proof: proof(late) }), true);
});

test('a flood of distinct nonces is refused rather than remembered forever', () => {
  const o = make();
  let ok = 0;
  for (let i = 0; i < 5000; i++) {
    const f = req({ nonce: `n${i}`.padEnd(24, '0') });
    if (o.verify({ ...f, proof: proof(f) })) ok++;
  }
  assert.ok(ok <= 4096, `remembered ${ok}`);
  assert.ok(ok >= 4000, `refused too early at ${ok}`);
});
