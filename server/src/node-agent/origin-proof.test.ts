import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { proofMessage, sign } from './origin-proof.js';

/**
 * THE TWO HALVES MUST AGREE, BYTE FOR BYTE.
 *
 * The host signs with the copy in this directory; the broker verifies with
 * its own, in a frozen root-owned release this tree does not import. A
 * divergence would not break a test anywhere else — it would make every proof
 * unverifiable, and the symptom would be "Slack asks every time again", which
 * is also exactly what a missing key looks like. So the agreement is asserted
 * here, against the broker's real module.
 */
const require = createRequire(import.meta.url);
const brokerPath = require.resolve('../../../broker/origins.mjs');
const broker = await import(brokerPath);

const cases = [
  { origin: 'trayo', action: 'slack.channels', payload: {}, ts: 1, nonce: 'n' },
  {
    origin: 'trayo',
    action: 'slack.post',
    payload: { channel: 'C1', text: 'hi' },
    ts: 2,
    nonce: 'm',
  },
  // Key order, nesting, arrays, null and undefined — every shape a payload
  // takes on the way through a relay that may re-serialise it.
  {
    origin: 'trayo',
    action: 'msgvault.search',
    payload: { z: 1, a: { d: [1, 2, { q: null }], c: 'x' }, b: undefined },
    ts: 3,
    nonce: 'o',
  },
  { origin: 'trayo', action: 'slack.upload', payload: { list: [], empty: {} }, ts: 4, nonce: 'p' },
];

describe('the host signs what the broker verifies', () => {
  it('canonicalises identically', () => {
    for (const c of cases) expect(proofMessage(c), c.action).toBe(broker.proofMessage(c));
  });

  it('produces the same signature for the same key', () => {
    const key = 'k'.repeat(48);
    for (const c of cases) expect(sign(key, c), c.action).toBe(broker.sign(key, c));
  });

  it('a payload written in a different key order signs the same', () => {
    const key = 'k'.repeat(48);
    const a = { origin: 'trayo', action: 'x', payload: { a: 1, b: 2 }, ts: 9, nonce: 'n' };
    const b = { origin: 'trayo', action: 'x', payload: { b: 2, a: 1 }, ts: 9, nonce: 'n' };
    expect(sign(key, a)).toBe(sign(key, b));
    expect(sign(key, a)).toBe(broker.sign(key, b));
  });

  it('a different action or payload signs differently', () => {
    const key = 'k'.repeat(48);
    const base = { origin: 'trayo', action: 'slack.channels', payload: {}, ts: 1, nonce: 'n' };
    expect(sign(key, { ...base, action: 'slack.post' })).not.toBe(sign(key, base));
    expect(sign(key, { ...base, payload: { a: 1 } })).not.toBe(sign(key, base));
    expect(sign(key, { ...base, origin: 'other' })).not.toBe(sign(key, base));
  });
});
