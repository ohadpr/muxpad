import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCAL_ORIGIN, loadPolicy, policyAllows, timedOriginTrusted } from './policy.mjs';

/**
 * THE POLICY, READ BY THE THING IT RESTRAINS.
 *
 * A review found that `/Library/muxpad/connectors.json` was read only by
 * muxpad's own server, while `/requests` is reachable without going through
 * muxpad at all — so the one component meant to hold against agents had never
 * heard of the rule it was meant to hold.
 */
const io = (text, problem) => ({
  readFileSync: () => {
    if (problem) throw Object.assign(new Error(problem.message), { code: problem.code });
    return text;
  },
  assertProtectedPath: () => {
    if (problem?.unprotected) throw new Error(problem.message);
  },
});

test('every failure refuses — absent included', () => {
  // Absent used to be unscoped, which was right while scoping was being
  // rolled out and is wrong now that it is the live arrangement: deleting a
  // file would switch every restraint off, silently.
  const absent = loadPolicy('/x', io(null, { code: 'ENOENT', message: 'no such file' }));
  assert.match(absent.problem, /missing/);
  assert.equal(policyAllows(absent, 'slack', 'anything').ok, false);

  // Anything OTHER than absence is a policy we cannot read. Treating that as
  // "no policy" would let anyone switch scoping off by breaking the file.
  for (const p of [
    { code: 'EACCES', message: 'permission denied' },
    { unprotected: true, message: 'Unprotected file or ancestor' },
  ]) {
    const broken = loadPolicy('/x', io(null, p));
    assert.match(broken.problem, /unreadable/);
    assert.equal(policyAllows(broken, 'slack', 'local').ok, false);
  }
  // …and so is a file that is not JSON, not an object, or whose central
  // switch is not a boolean. `"true"` is the most likely way to mistype this
  // file and it used to read as FALSE — allowing everything.
  assert.match(loadPolicy('/x', io('{nope')).problem, /not valid JSON/);
  assert.match(loadPolicy('/x', io('[]')).problem, /not an object/);
  for (const bad of ['"true"', '1', '0', 'null', '"yes"']) {
    const p = loadPolicy('/x', io(`{"enforce": ${bad}, "allow": {"slack": ["trayo"]}}`));
    assert.match(p.problem, /must be true or false/, bad);
    assert.equal(policyAllows(p, 'slack', 'trayo').ok, false, bad);
  }
  assert.match(loadPolicy('/x', io('{"allow": {}}')).problem, /must be true or false/);
  // A real boolean still works, both ways.
  assert.equal(loadPolicy('/x', io('{"enforce": false, "allow": {}}')).problem, undefined);
  assert.equal(policyAllows(loadPolicy('/x', io('{"enforce": false, "allow": {}}')), 'slack', 'x').ok, true);
});

test('it enforces exactly what the file says', () => {
  const p = loadPolicy(
    '/x',
    io('{"enforce": true, "allow": {"slack": ["trayo"], "msgvault": ["local"]}}'),
  );
  assert.equal(p.enforce, true);
  assert.equal(policyAllows(p, 'slack', 'trayo').ok, true);
  assert.equal(policyAllows(p, 'msgvault', 'local').ok, true);
  for (const [cap, origin, re] of [
    ['slack', 'local', /slack is scoped to trayo/],
    ['msgvault', 'trayo', /msgvault is scoped to local/],
    ['slack', undefined, /is from unknown/],
    ['nope', 'local', /no machine is allowed to use nope/],
  ]) {
    const v = policyAllows(p, cap, origin);
    assert.equal(v.ok, false, `${cap}/${origin}`);
    assert.match(v.reason, re);
  }
});

test('the allow map cannot be reached through Object’s own properties', () => {
  // `allow['constructor']` must not find a function and read as permission.
  const p = loadPolicy('/x', io('{"enforce": true, "allow": {"slack": ["local"]}}'));
  for (const cap of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.equal(policyAllows(p, cap, 'local').ok, false, cap);
});

test('malformed entries are dropped rather than half-trusted', () => {
  const p = loadPolicy(
    '/x',
    io('{"enforce": true, "allow": {"slack": "trayo", "msgvault": [], "ok": ["local", 7, "../x"]}}'),
  );
  assert.equal(policyAllows(p, 'slack', 'trayo').ok, false, 'a string is not a machine list');
  assert.equal(policyAllows(p, 'msgvault', 'local').ok, false, 'an empty list allows nobody');
  // The good entry survives, with the junk machines filtered out.
  assert.equal(policyAllows(p, 'ok', 'local').ok, true);
  assert.equal(policyAllows(p, 'ok', '../x').ok, false);
});

test('only an origin whose claim adds nothing may hold a duration', () => {
  // Not a design, a floor: `origin` is caller-chosen on an endpoint with no
  // caller authentication, so a lasting permission may only rest on the one
  // claim that is already true — that the request came from this machine.
  assert.equal(timedOriginTrusted(LOCAL_ORIGIN), true);
  for (const o of ['trayo', 'unknown', '', undefined, null, 'LOCAL'])
    assert.equal(timedOriginTrusted(o), false, String(o));
});
