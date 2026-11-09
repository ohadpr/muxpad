import { readFileSync } from 'node:fs';
import { assertProtectedPath } from './protected-path.mjs';

/**
 * THE HOST POLICY, READ BY THE THING IT IS SUPPOSED TO RESTRAIN.
 *
 * ── WHY THIS MOVED ───────────────────────────────────────────────────────
 * `/Library/muxpad/connectors.json` was read only by muxpad's own server. A
 * review put the consequence plainly: the broker is the one component that is
 * meant to hold against agents, and it was the one component that had never
 * heard of the policy. Any process on the mini could read the broker's URL
 * from a world-readable file and POST straight to `/requests`, skipping every
 * check muxpad makes on the way.
 *
 * So the broker reads it too. Same file, same trust rules — root-owned, no
 * group or other write, no ACLs, all the way up — and a file it cannot trust
 * means REFUSE, never "no policy".
 *
 * ── AND WHAT THIS STILL CANNOT DO ────────────────────────────────────────
 * It cannot tell you WHICH MACHINE IS ASKING. Every request reaches this
 * broker from the mini's muxpad, over a loopback-reachable endpoint with no
 * caller authentication, so `origin` is a string the caller chose. Checking a
 * policy against a self-asserted origin stops an honest mistake and a
 * misrouted chat; it does not stop a process that lies.
 *
 * That is why `timedOriginTrusted` exists below and why it is deliberately
 * narrow. See core.mjs for how it is used: a capability the policy does not
 * grant to the asserted origin is refused outright, and a DURATION is only
 * ever offered for an origin whose claim adds nothing — `local`, which is
 * where the request physically came from anyway.
 */

export const POLICY_PATH = '/Library/muxpad/connectors.json';

/** The machine the broker runs on. A request asserting this is asserting the
 *  thing that is already true, so believing it costs nothing. */
export const LOCAL_ORIGIN = 'local';

const EMPTY = Object.freeze({ enforce: false, allow: Object.create(null) });

/**
 * Read and parse the policy.
 *
 * EVERY failure is a `problem`, and a `problem` refuses every call: absent,
 * unreadable, not JSON, not an object, or an `enforce` that is not a boolean.
 * There is no shape of this file that means "allow everything by accident".
 */
export function loadPolicy(path = POLICY_PATH, io = { readFileSync, assertProtectedPath }) {
  let raw;
  try {
    io.assertProtectedPath(path, [0]);
    raw = io.readFileSync(path, 'utf8');
  } catch (error) {
    // ── ABSENT IS NOT PERMISSION ──────────────────────────────────────────
    // This used to read ENOENT as "unscoped", which was right while scoping
    // was being rolled out and is wrong now that it is the live arrangement:
    // deleting a file would switch every restraint off, silently. There is a
    // policy on this machine; its absence is a broken install, not consent.
    if (error?.code === 'ENOENT')
      return { ...EMPTY, problem: `connector policy missing at ${path}` };
    return { ...EMPTY, problem: `connector policy unreadable: ${String(error?.message ?? error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY, problem: 'connector policy is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ...EMPTY, problem: 'connector policy is not an object' };
  // ── `enforce` MUST BE A BOOLEAN ───────────────────────────────────────
  // It was `parsed.enforce === true`, so `"true"` — a string, and the most
  // likely way to mistype this file — read as FALSE and allowed everything.
  // A policy whose central switch cannot be read is a policy we cannot obey.
  if (typeof parsed.enforce !== 'boolean')
    return {
      ...EMPTY,
      problem: `connector policy "enforce" must be true or false, not ${JSON.stringify(parsed.enforce)}`,
    };
  // Null prototype: `allow['constructor']` must not find Object's own.
  const allow = Object.create(null);
  const src = parsed.allow;
  if (src && typeof src === 'object' && !Array.isArray(src))
    for (const [k, v] of Object.entries(src))
      if (/^[a-z][a-z0-9_-]{0,31}$/.test(k) && Array.isArray(v)) {
        const machines = v.filter((m) => typeof m === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(m));
        if (machines.length) allow[k] = machines;
      }
  return { enforce: parsed.enforce, allow };
}

/**
 * May `capability` be used by a chat claiming to be on `origin`?
 *
 * Returns a reason when not. The reason is shown to nobody but the caller —
 * it names the rule so a misrouted chat can say so rather than retry.
 */
export function policyAllows(policy, capability, origin) {
  if (policy.problem) return { ok: false, reason: policy.problem };
  if (!policy.enforce) return { ok: true, enforced: false };
  const allowed = Object.hasOwn(policy.allow, capability) ? policy.allow[capability] : undefined;
  if (!allowed || allowed.length === 0)
    return { ok: false, reason: `no machine is allowed to use ${capability}` };
  const who = typeof origin === 'string' && origin ? origin : 'unknown';
  if (!allowed.includes(who))
    return {
      ok: false,
      reason: `${capability} is scoped to ${allowed.join(', ')}; this request says it is from ${who}`,
    };
  return { ok: true, enforced: true };
}

/**
 * MAY A TIMED GRANT BE MINTED OR SPENT FOR THIS ORIGIN?
 *
 * Only for `local`, and the reasoning is worth keeping next to the rule.
 *
 * A timed grant is the one thing here that runs WITHOUT a human in the loop,
 * so it may only rest on something the broker can actually check. It cannot
 * check `origin`: the field is chosen by the caller, the endpoint has no
 * caller authentication, and every request arrives from the same machine as
 * the agents it is meant to restrain. A grant bound to `trayo` is therefore
 * spendable by anything on the mini willing to type `"origin":"trayo"`.
 *
 * `local` is different only because believing it adds nothing — the request
 * did come from this machine. So a remote origin gets approve-once: you see
 * the action, and then it happens.
 *
 * This is a FLOOR, not a design. The real fix is authenticating the caller so
 * `origin` is evidence rather than a label; until that exists, nothing here
 * should be described as a guarantee.
 */
export function timedOriginTrusted(origin) {
  return (origin ?? 'unknown') === LOCAL_ORIGIN;
}
