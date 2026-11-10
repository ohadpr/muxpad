import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertProtectedPath } from './protected-path.mjs';

/**
 * WHICH MACHINE IS ASKING — as evidence rather than as a label.
 *
 * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────
 * `origin` has been a string the caller chose. policy.mjs says so in writing
 * and `timedOriginTrusted` was built around it: a capability the policy does
 * not grant to the asserted origin is refused, but a DURATION was only ever
 * offered for `local`, because believing "I am local" adds nothing — the
 * request did come from this machine.
 *
 * The cost landed on the one machine that is supposed to use Slack. Every
 * call from the Trayo VM asked for approval again, forever, because a grant
 * bound to `trayo` would have been spendable by anything on the mini willing
 * to type `"origin":"trayo"`.
 *
 * ── WHY A SHARED KEY, AND WHY IT HAS TO LIVE OVER THERE ────────────────────
 * The obvious fix — have the broker check WHO CONNECTED — cannot work here.
 * Every request arrives from the mini's muxpad, and muxpad runs as the same
 * user as the agents it is meant to restrain, so a peer-credential check
 * cannot tell the server from an agent pretending to be it. Any secret the
 * server can read, an agent can read.
 *
 * So the evidence has to be minted somewhere an agent on THIS machine cannot
 * reach: on the remote host itself. The node agent over there holds a key,
 * signs each connector request, and muxpad relays the proof without being
 * able to make one. The mini cannot forge `trayo` because the key is not on
 * the mini — only the broker's copy is, under root, where the user's agents
 * cannot read it either.
 *
 * ── WHAT IT DOES NOT CLAIM ─────────────────────────────────────────────────
 * It proves the request was minted on that MACHINE. It does not say which
 * agent, or which chat: on the VM the key is readable by anything running as
 * that user, exactly as here. That is the right granularity for the question
 * being asked — the policy is about machines ("slack: trayo") — but it is not
 * a claim about people, and nothing downstream should read it as one.
 */

/** Root-owned, one file per origin, mode 0600 and owned by the broker. */
export const ORIGINS_DIR = '/Library/muxpad/origins';

/** How far a proof's clock may be from the broker's. Long enough for a slow
 *  tailnet hop, short enough that a captured proof is worthless by the time
 *  anybody could reuse it — and the nonce below makes reuse impossible
 *  anyway, so this is the second of two locks, not the only one. */
export const SKEW_MS = 120_000;

/** How long a key file's contents are trusted without re-reading it. See
 *  `Origins#key` for why this is not Infinity. */
export const KEY_TTL_MS = 60_000;

/** `local` is the one origin with no key and no proof: believing a request
 *  that came from this machine when it says it came from this machine adds
 *  nothing to what the socket already told us. */
export const LOCAL_ORIGIN = 'local';

/** An origin names a file, so it may not name a path. */
const NAME = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

/** The bytes a proof signs. Canonical and explicit — every field that the
 *  broker will act on is in here, so a proof for one action cannot be
 *  replayed onto another. */
export function proofMessage({ origin, action, payload, ts, nonce }) {
  return JSON.stringify([String(origin), String(action), stable(payload), Number(ts), String(nonce)]);
}

/** Key order must not change the bytes, or an honest relay breaks the proof. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value === undefined ? null : value;
}

export function sign(key, fields) {
  return createHmac('sha256', key).update(proofMessage(fields)).digest('base64url');
}

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Verifies origin proofs, and remembers the nonces it has already honoured.
 *
 * ONE INSTANCE PER BROKER. The replay memory is the whole point of the class:
 * a proof is good once. Bounded, because an unbounded cache fed by a caller
 * is a way to exhaust the broker rather than to lie to it.
 */
export class Origins {
  #keys = new Map();
  #seen = new Map();
  #io;
  #dir;
  #now;
  constructor({ dir = ORIGINS_DIR, now = Date.now, io = { readFileSync, assertProtectedPath } } = {}) {
    this.#dir = dir;
    this.#now = now;
    this.#io = io;
  }

  /**
   * The key for an origin, or null. Cached for a minute, not forever.
   *
   * Forever was wrong in both directions and the failures were silent ones.
   * A key INSTALLED while the broker is running was remembered as absent, so
   * the install looked complete and nothing was ever proven until somebody
   * restarted the broker — and `muxpad restart` does not restart it. A key
   * ROTATED on the host side kept being checked against the old bytes here,
   * so every proof failed and the only symptom was a dialog that would not
   * stop appearing.
   *
   * A minute is short enough that neither outlives a cup of coffee and long
   * enough that a filesystem check is not part of every Slack call. The path
   * is re-asserted on every re-read, so a key that becomes readable by the
   * user's agents stops being used within the same minute — which is the one
   * direction where staleness would be dangerous rather than merely
   * annoying.
   */
  key(origin) {
    if (!NAME.test(String(origin ?? ''))) return null;
    const cached = this.#keys.get(origin);
    if (cached && cached.until > this.#now()) return cached.key;
    let key = null;
    try {
      const path = join(this.#dir, `${origin}.key`);
      // Same discipline as the policy file: root all the way up, no group or
      // other write, no ACLs. A key the user's agents can read is not a key.
      this.#io.assertProtectedPath(path, [0, process.getuid?.() ?? 0], { mode: 0o600 });
      const raw = this.#io.readFileSync(path, 'utf8').trim();
      if (raw.length >= 32) key = raw;
    } catch {
      key = null;
    }
    this.#keys.set(origin, { key, until: this.#now() + KEY_TTL_MS });
    return key;
  }

  /**
   * Is this request's origin PROVEN?
   *
   * Never throws and never refuses a request: an absent, stale or wrong proof
   * means the origin is a label again, which is where everything already
   * stood. The only consequence of failing here is that no duration is
   * offered — the human still sees the action and can approve it once.
   *
   * Degrading rather than refusing is deliberate. A key that gets rotated on
   * one side only must not take Slack off the air on the machine that is the
   * only one allowed to use it; it must make the dialog ask every time, which
   * is exactly the "something is wrong" signal a person can act on.
   */
  verify({ origin, action, payload, proof }) {
    if (origin === LOCAL_ORIGIN) return true;
    if (!proof || typeof proof !== 'object') return false;
    const key = this.key(origin);
    if (!key) return false;
    const { ts, nonce, sig } = proof;
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) return false;
    if (typeof sig !== 'string' || !Number.isFinite(ts)) return false;
    const now = this.#now();
    if (Math.abs(now - ts) > SKEW_MS) return false;
    const expected = sign(key, { origin, action, payload, ts, nonce });
    if (!same(expected, sig)) return false;
    // ONCE. Checked last, so a forged signature can never evict an honest
    // nonce from the memory below.
    const id = `${origin}:${nonce}`;
    this.#forget(now);
    if (this.#seen.has(id)) return false;
    if (this.#seen.size >= 4096) return false;
    this.#seen.set(id, now + SKEW_MS * 2);
    return true;
  }

  #forget(now) {
    for (const [id, until] of this.#seen) if (until <= now) this.#seen.delete(id);
  }
}
