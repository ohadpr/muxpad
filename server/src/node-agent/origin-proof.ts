import { createHmac } from 'node:crypto';

/**
 * THE HOST'S HALF OF AN ORIGIN PROOF.
 *
 * A deliberate second copy of `broker/origins.mjs`'s signing half, because
 * the two halves must not share a module: the broker is a frozen, root-owned
 * release that this tree does not import, and the host agent is TypeScript
 * that ships with muxpad. What keeps them honest is not a shared file but
 * `origin-proof.test.ts`, which imports the broker's real module and asserts
 * the bytes are identical — so a change to either canonical form fails the
 * build rather than silently making every proof unverifiable.
 *
 * Signing lives HERE, on the host, and verification lives over there. That
 * asymmetry is the point: the machine that must prove itself is the only one
 * holding the key.
 */

/** Key order must not change the bytes, or an honest relay breaks the proof. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  return value === undefined ? null : value;
}

export interface ProofFields {
  origin: string;
  action: string;
  payload: unknown;
  ts: number;
  nonce: string;
}

/** The bytes a proof signs — every field the broker will act on. */
export function proofMessage({ origin, action, payload, ts, nonce }: ProofFields): string {
  return JSON.stringify([
    String(origin),
    String(action),
    stable(payload),
    Number(ts),
    String(nonce),
  ]);
}

export function sign(key: string, fields: ProofFields): string {
  return createHmac('sha256', key).update(proofMessage(fields)).digest('base64url');
}
