import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Broker } from './core.mjs';
import { HumanSessions, SESSION_COOKIE } from './human-session.mjs';

/**
 * TWO THINGS A TIMED APPROVAL NOW CARRIES: a verb class, and an origin.
 *
 * What shipped: approving "Slack for a day" minted a grant over all eleven
 * actions for the whole team, recording nothing about who had asked. So the
 * owner's own worry — "I don't want to approve slack for a day and discover my
 * personal chats have been using slack" — was exactly right, and so was the
 * second half of it that nobody had said out loud: a day of READING also
 * bought a day of POSTING.
 *
 * `timedGrants: 'read'` fixes the first. The origin in the grant's scope fixes
 * the second, and it fixes it in BOTH modes, because matching is scope
 * equality — a request from another machine simply does not find the grant and
 * goes to the human instead.
 *
 * The mode DEFAULTS to what shipped. A security change that arrives silently
 * with an upgrade is one nobody reviewed.
 */

const secret = 'a-long-random-test-only-pairing-secret-12345';

function fixture({ timedGrants } = {}) {
  let now = 1000;
  let elapsed = 0;
  const state = {};
  const calls = [];
  const config = {
    origin: 'https://approve.example.test',
    rpID: 'approve.example.test',
    teamID: 'T123',
    muxpadURL: 'https://muxpad.example.test/',
    approvalMode: 'session',
    bootstrapHash: createHash('sha256').update(secret).digest('base64url'),
    ...(timedGrants ? { timedGrants } : {}),
  };
  const save = () => {};
  const sessions = new HumanSessions({ config, state, save, now: () => now });
  const broker = new Broker({
    config,
    state,
    save,
    now: () => now,
    elapsed: () => elapsed,
    slack: async (a, p) => {
      calls.push([a, p]);
      return { channel: 'C123', ts: '1.2' };
    },
  });
  const pair = () => {
    const result = sessions.pair(secret);
    const cookie = `${SESSION_COOKIE}=${result.token}`;
    sessions.authenticate(cookie);
    return state.humanSessions[0];
  };
  return { broker, state, calls, pair, config };
}

const ask = (f, action, origin) =>
  f.broker.create({
    action,
    payload: action === 'slack.post' ? { ref: 'C123', text: 'hi' } : { ref: 'C123' },
    ...(origin ? { origin } : {}),
  });

/** Approve `r` for a duration, naming the scope this install uses. */
const approveFor = (f, r, duration, session, scope) =>
  f.broker.decideSession(r.id, r.fingerprint, 'approve', { duration, scope, session });

test('by default nothing changes: a timed grant still covers every action', async () => {
  const f = fixture();
  const session = f.pair();
  const r = await ask(f, 'slack.post', 'trayo');
  const out = await approveFor(f, r, '10m', session, 'slack-team-all-v2');
  assert.equal(out.state, 'complete');
  assert.deepEqual(f.broker.listGrants()[0].permissionScope, 'slack-team-all-v2');
});

test('under timedGrants:read a WRITE cannot be approved for a duration at all', async () => {
  const f = fixture({ timedGrants: 'read' });
  const session = f.pair();
  const r = await ask(f, 'slack.post', 'trayo');
  await assert.rejects(
    approveFor(f, r, '1d', session, 'slack-team-read-v1'),
    /slack\.post cannot be approved for a duration/,
  );
  // …and it is still approvable once, which is the whole point: you see the
  // message, and then it is sent.
  assert.equal((await f.broker.decideSession(r.id, r.fingerprint, 'approve')).state, 'complete');
});

test('under timedGrants:read the grant covers the five read verbs and no others', async () => {
  const f = fixture({ timedGrants: 'read' });
  const session = f.pair();
  const r = await ask(f, 'slack.read', 'trayo');
  await approveFor(f, r, '1h', session, 'slack-team-read-v1');
  const grant = f.broker.listGrants()[0];
  assert.deepEqual([...grant.actions].sort(), [
    'slack.channels',
    'slack.read',
    'slack.search',
    'slack.thread',
    'slack.users',
  ]);
  for (const write of ['slack.post', 'slack.dm', 'slack.react', 'slack.edit', 'slack.upload'])
    assert.ok(!grant.actions.includes(write), `${write} must not be in a timed grant`);
});

test('a client that names the OLD scope is refused, not quietly narrowed', async () => {
  // The string it sent is the promise it DISPLAYED. Accepting a different one
  // would approve something other than what the human read.
  const f = fixture({ timedGrants: 'read' });
  const session = f.pair();
  const r = await ask(f, 'slack.read', 'trayo');
  await assert.rejects(
    approveFor(f, r, '10m', session, 'slack-team-all-v2'),
    /Timed approval covers reading only/,
  );
});

test('a timed grant is spendable only by the machine it was approved for', async () => {
  const f = fixture({ timedGrants: 'read' });
  const session = f.pair();
  const approved = await ask(f, 'slack.read', 'trayo');
  await approveFor(f, approved, '1h', session, 'slack-team-read-v1');
  assert.equal(f.calls.length, 1);

  // Same machine: dispatched without asking again.
  const same = await ask(f, 'slack.read', 'trayo');
  assert.notEqual(f.broker.view(same.id).state, 'pending');
  assert.equal(f.calls.length, 2);

  // ANOTHER machine: the grant does not match, so it goes to the human. This
  // is the owner's exact worry — a day approved for the work VM must not be
  // spendable by a personal chat.
  const elsewhere = await ask(f, 'slack.read', 'local');
  assert.equal(f.broker.view(elsewhere.id).state, 'pending');
  assert.equal(f.calls.length, 2);
});

test('a request with no origin never rides a grant minted for a named one', async () => {
  // Fail-closed for an older muxpad that does not send an origin: it gets
  // per-request approval rather than inheriting somebody else's day.
  const f = fixture({ timedGrants: 'read' });
  const session = f.pair();
  const approved = await ask(f, 'slack.read', 'trayo');
  await approveFor(f, approved, '1h', session, 'slack-team-read-v1');
  const anonymous = await ask(f, 'slack.read');
  assert.equal(f.broker.view(anonymous.id).state, 'pending');
});

test('the origin is recorded on the request, so the prompt can show it', async () => {
  const f = fixture();
  f.pair(); // a request needs a paired human before it can be created at all
  const r = await ask(f, 'slack.post', 'trayo');
  assert.equal(f.broker.view(r.id).origin, 'trayo');
  // A junk origin is not trusted into the record; it becomes `unknown`, which
  // matches no named grant.
  const bad = await ask(f, 'slack.post', '../../etc/passwd');
  assert.equal(f.broker.view(bad.id).origin, 'unknown');
});

test('origin binding holds in the DEFAULT mode too', async () => {
  // The narrowing is opt-in; the binding is not, because it costs nothing and
  // an install that has not flipped the switch still should not spend one
  // machine's day on another's request.
  const f = fixture();
  const session = f.pair();
  const approved = await ask(f, 'slack.read', 'trayo');
  await approveFor(f, approved, '1h', session, 'slack-team-all-v2');
  const elsewhere = await ask(f, 'slack.read', 'local');
  assert.equal(f.broker.view(elsewhere.id).state, 'pending');
});

test('the fingerprint moves with the origin, so a displayed one cannot be swapped', () => {
  // The decision is taken against the fingerprint. If the origin were only in
  // the VIEW, a relay could show you "trayo", collect the approval, and have
  // it apply to a request from somewhere else — and the grant it mints is
  // scoped by exactly this field.
  const f = fixture();
  const base = {
    id: 'same-id',
    action: 'slack.read',
    teamID: 'T123',
    payload: { ref: 'C123' },
    expires: 9_999,
    nonce: 'same-nonce',
  };
  const a = f.broker.fingerprint({ ...base, origin: 'trayo' });
  const b = f.broker.fingerprint({ ...base, origin: 'local' });
  assert.notEqual(a, b);
  // …and an absent origin is not the same as any named one.
  assert.notEqual(f.broker.fingerprint(base), a);
  // Identical inputs still agree, or nothing could be approved at all.
  assert.equal(a, f.broker.fingerprint({ ...base, origin: 'trayo' }));
});
