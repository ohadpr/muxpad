import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Broker } from './core.mjs';
import { HumanSessions, SESSION_COOKIE } from './human-session.mjs';
import { Origins, sign } from './origins.mjs';

/**
 * ONE APPROVAL MECHANISM, APPLIED TO A SECOND THING.
 *
 * The owner's rule, after being handed a read-only msgvault grant with no
 * dialog in front of it: if we define something as needing approval then it
 * runs in a zone the agent cannot reach, every use goes through a muxpad tool
 * that raises the dialog, the agent never receives the key, and when the
 * window times out the agent can no longer make calls.
 *
 * These tests are that sentence, one property per test, on the capability
 * that was NOT the one the broker was written for.
 */
const secret = 'a-long-random-test-only-pairing-secret-12345';

function fixture({ timedGrants, origins } = {}) {
  let now = 1000;
  let elapsed = 0;
  const state = {};
  const ran = [];
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
    // UNSCOPED, INJECTED. The broker reads the host policy itself now, and a
    // test that fell through to the real /Library/muxpad/connectors.json would
    // pass or fail on the state of the machine it runs on.
    hostPolicy: () => ({ enforce: false, allow: {} }),
    config,
    state,
    save,
    now: () => now,
    elapsed: () => elapsed,
    ...(origins ? { origins } : {}),
    slack: async () => ({ channel: 'C123', ts: '1.2' }),
    msgvault: async (action, payload) => {
      ran.push([action, payload]);
      return { ok: true };
    },
  });
  const pair = () => {
    const result = sessions.pair(secret);
    sessions.authenticate(`${SESSION_COOKIE}=${result.token}`);
    return state.humanSessions[0];
  };
  return {
    broker,
    ran,
    pair,
    tick: (ms) => {
      now += ms;
      elapsed += ms;
    },
  };
}

// `local` by default: the broker only grants a DURATION to an origin whose
// claim adds nothing, because the field is caller-chosen on an endpoint with
// no caller authentication. See policy.mjs and the test below.
const ask = (f, action, payload, origin = 'local') => f.broker.create({ action, payload, origin });

test('nothing runs until a human approves it', async () => {
  const f = fixture();
  const session = f.pair();
  const r = await ask(f, 'msgvault.search', { query: 'from:a@b.com' });
  assert.equal(r.state, 'pending');
  assert.deepEqual(f.ran, []); // the archive has not been touched
  assert.equal(
    (await f.broker.decideSession(r.id, r.fingerprint, 'approve', { session })).state,
    'complete',
  );
  assert.deepEqual(f.ran, [['msgvault.search', { query: 'from:a@b.com', limit: 50 }]]);
});

test('a rejection runs nothing, and cannot be replayed into a run', async () => {
  const f = fixture();
  const session = f.pair();
  const r = await ask(f, 'msgvault.search', { query: 'tax' });
  assert.equal(
    (await f.broker.decideSession(r.id, r.fingerprint, 'reject', { session })).state,
    'rejected',
  );
  assert.deepEqual(f.ran, []);
  await assert.rejects(
    f.broker.decideSession(r.id, r.fingerprint, 'approve', { session }),
    /changed, expired or already consumed/,
  );
  assert.deepEqual(f.ran, []);
});

test('a timed grant runs later calls — and STOPS when the window closes', async () => {
  const f = fixture();
  const session = f.pair();
  const first = await ask(f, 'msgvault.search', { query: 'one' });
  assert.equal(
    (
      await f.broker.decideSession(first.id, first.fingerprint, 'approve', {
        duration: '10m',
        scope: 'msgvault-all-v1',
        session,
      })
    ).state,
    'complete',
  );
  // Inside the window: no dialog, it just runs.
  f.tick(60_000);
  const second = await ask(f, 'msgvault.search', { query: 'two' });
  assert.equal(second.state, 'complete');
  assert.equal(f.ran.length, 2);

  // Past it: back to pending, and the archive is not touched.
  f.tick(10 * 60_000);
  const third = await ask(f, 'msgvault.search', { query: 'three' });
  assert.equal(third.state, 'pending');
  assert.equal(f.ran.length, 2);
});

test('a grant is bound to the machine that asked — and only `local` may hold one', async () => {
  const f = fixture();
  const session = f.pair();
  const r = await ask(f, 'msgvault.stats', {}, 'local');
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '1h',
    scope: 'msgvault-all-v1',
    session,
  });
  assert.equal(f.ran.length, 1);
  // The same verb from a different machine does not find it.
  assert.equal((await ask(f, 'msgvault.stats', {}, 'trayo')).state, 'pending');
  // …and a machine that does not PROVE it asked cannot mint one of its own.
  // `origin` is a caller-chosen string on an unauthenticated endpoint, so a
  // grant bound to an unproven remote name would be spendable by anything on
  // THIS machine willing to claim it.
  const remote = await ask(f, 'msgvault.stats', {}, 'trayo');
  assert.equal(remote.timedAllowed, false);
  assert.match(remote.timedRefusedReason, /did not prove it/);
  await assert.rejects(
    f.broker.decideSession(remote.id, remote.fingerprint, 'approve', {
      duration: '1h',
      scope: 'msgvault-all-v1',
      session,
    }),
    /can only be approved once/,
  );
  assert.equal(f.ran.length, 1);
  // …nor does a request that names no machine at all.
  assert.equal((await f.broker.create({ action: 'msgvault.stats', payload: {} })).state, 'pending');
  assert.equal(f.ran.length, 1);
});

test('a Slack grant buys nothing on the archive, and the reverse', async () => {
  const f = fixture();
  const session = f.pair();
  const s = await ask(f, 'slack.read', { ref: 'C123' });
  await f.broker.decideSession(s.id, s.fingerprint, 'approve', {
    duration: '1h',
    scope: 'slack-team-all-v2',
    session,
  });
  // A live Slack grant, and the archive still asks.
  assert.equal(f.broker.listGrants().length, 1);
  assert.equal((await ask(f, 'msgvault.search', { query: 'x' })).state, 'pending');
  assert.deepEqual(f.ran, []);

  // TWO INDEPENDENT REASONS, AND BOTH ARE ASSERTED. The action list alone
  // already refuses this, which is why a capability-BLIND scope passed every
  // other test here — so the scope is pinned separately. A later change that
  // widens one must not be able to lean on the other without a test saying so.
  const grant = f.broker.listGrants()[0];
  assert.ok(!grant.actions.some((a) => a.startsWith('msgvault.')));
  assert.match(grant.permissionScope, /^slack-/);
  const mv = await ask(f, 'msgvault.stats', {});
  assert.notEqual(
    JSON.parse(f.broker.grantScope(f.broker.get(mv.id))).permissionScope,
    grant.permissionScope,
  );
});

test("the scope it advertises is its own, not Slack's", async () => {
  // `timedScope` is what the approval page DISPLAYS and what the client sends
  // back when you pick a duration. It sat one line above `timedAllowed`, which
  // was made capability-aware while this was left alone — so an archive read
  // advertised `slack-team-all-v2`, the page offered "full Slack access" for a
  // mail read, and the duration came back as a scope decideSession refused.
  const f = fixture();
  const session = f.pair();
  const r = await ask(f, 'msgvault.search', { query: 'x' });
  assert.equal(r.timedScope, 'msgvault-all-v1');
  const s = await ask(f, 'slack.read', { ref: 'C123' });
  assert.equal(s.timedScope, 'slack-team-all-v2');
  // …and the scope it advertises is the one a duration is actually accepted
  // with, which is the property that was broken.
  assert.equal(
    (
      await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
        duration: '1h',
        scope: r.timedScope,
        session,
      })
    ).state,
    'complete',
  );
});

test('the owner’s timedGrants switch decides how wide an msgvault duration is', async () => {
  // It used to be "msgvault has no write set at all, so the switch has
  // nothing to hold back". It has one now — the draft verbs — and the owner
  // chose that a duration covers them: "CRUD for drafts should fall under
  // the blanket msgvault approval, these are just drafts they are not sent
  // automatically." So the switch means for msgvault what it means for
  // Slack: `read` narrows a duration to the reads, the default covers the
  // whole capability.
  for (const [timedGrants, scope] of [
    [undefined, 'msgvault-all-v1'],
    ['read', 'msgvault-read-v1'],
  ]) {
    const f = fixture({ ...(timedGrants ? { timedGrants } : {}) });
    const session = f.pair();
    const r = await ask(f, 'msgvault.search', { query: 'x' });
    assert.equal(r.timedAllowed, true, String(timedGrants));
    assert.equal(r.timedScope, scope, String(timedGrants));
    assert.equal(
      (
        await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
          duration: '1d',
          scope,
          session,
        })
      ).state,
      'complete',
    );
    assert.equal(f.broker.listGrants()[0].permissionScope, scope);
  }
});

test('an unregistered action never reaches a validator or an executor', async () => {
  const f = fixture();
  f.pair(); // or the pairing check answers first and proves nothing
  // `msgvault.draft` is in this list because composing a new email is not a
  // verb muxpad has: a Gmail source refuses `draft-compose` outright.
  for (const action of [
    'msgvault.query',
    'msgvault.export-messages',
        'msgvault.draft',
  ])
    await assert.rejects(f.broker.create({ action, payload: {} }), /Unsupported action/, action);
  assert.deepEqual(f.ran, []);
});

/**
 * …AND THE MACHINE THAT DOES PROVE IT.
 *
 * This is the half that did not exist. Every call from the one machine the
 * policy actually permits to use Slack asked for approval again, forever,
 * because a grant bound to `trayo` would have been spendable by anything on
 * the mini willing to type the name. A host holding a key the broker also
 * holds can sign the request it is asking for — which the hosting machine
 * cannot forge, because the key is not on it.
 */
const KEY = 'trayo-key-'.padEnd(48, 'x');
const knowing = (keys, now) =>
  new Origins({
    dir: '/x',
    now,
    io: {
      readFileSync: (path) => {
        const name = String(path)
          .split('/')
          .pop()
          .replace(/\.key$/, '');
        if (!(name in keys)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return keys[name];
      },
      assertProtectedPath: () => {},
    },
  });
/** A signed request body, the way the remote node agent builds one. */
const signed = (action, payload, origin, ts, key = KEY) => {
  const nonce = `${Math.random()}`.padEnd(24, '0');
  return {
    action,
    payload,
    origin,
    proof: { ts, nonce, sig: sign(key, { origin, action, payload, ts, nonce }) },
  };
};

test('a remote host that PROVES it asked may hold a timed grant', async () => {
  const now = 1000;
  const f = fixture({ origins: knowing({ trayo: KEY }, () => now) });
  const session = f.pair();
  const r = await f.broker.create(signed('msgvault.stats', {}, 'trayo', now));
  assert.equal(r.timedAllowed, true, 'a proven origin may be trusted for a duration');
  assert.equal(r.timedRefusedReason, undefined);
  assert.equal(
    (
      await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
        duration: '1h',
        scope: 'msgvault-all-v1',
        session,
      })
    ).state,
    'complete',
  );
  // …and the next call from that machine rides the grant, with no dialog.
  const second = await f.broker.create(signed('msgvault.stats', {}, 'trayo', now));
  assert.equal(second.state, 'complete');
  assert.equal(f.ran.length, 2);
});

test('the hosting machine cannot forge the proof, so it cannot spend the grant', async () => {
  const now = 1000;
  const f = fixture({ origins: knowing({ trayo: KEY }, () => now) });
  const session = f.pair();
  const r = await f.broker.create(signed('msgvault.stats', {}, 'trayo', now));
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '1h',
    scope: 'msgvault-all-v1',
    session,
  });
  assert.equal(f.ran.length, 1);
  // Anything on the mini can type "trayo". Without the key it gets a dialog,
  // which is the entire point of binding the grant to a PROOF.
  const liar = await f.broker.create(
    signed('msgvault.stats', {}, 'trayo', now, 'a key the mini does not have!!'),
  );
  assert.equal(liar.state, 'pending');
  assert.equal(liar.timedAllowed, false);
  assert.equal(f.ran.length, 1);
  // …and a bare claim with no proof at all, likewise.
  assert.equal(
    (await f.broker.create({ action: 'msgvault.stats', payload: {}, origin: 'trayo' })).state,
    'pending',
  );
  assert.equal(f.ran.length, 1);
});

test('a proof is spent once, so a captured request cannot be replayed into the grant', async () => {
  const now = 1000;
  const f = fixture({ origins: knowing({ trayo: KEY }, () => now) });
  f.pair();
  const body = signed('msgvault.stats', {}, 'trayo', now);
  const first = await f.broker.create(body);
  assert.equal(first.timedAllowed, true);
  const again = await f.broker.create(body);
  assert.equal(again.timedAllowed, false, 'the same proof must not prove twice');
});

test('until-revoked outlives the clock, and dies with the session that minted it', async () => {
  let now = 1000;
  const f = fixture({ origins: knowing({ trayo: KEY }, () => now) });
  const session = f.pair();
  const r = await f.broker.create(signed('msgvault.stats', {}, 'trayo', now));
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: 'until-revoked',
    scope: 'msgvault-all-v1',
    session,
  });
  assert.equal(f.ran.length, 1);
  // A day later — where `1d` would have lapsed — it still runs.
  f.tick(86_400_000 + 60_000);
  now += 86_400_000 + 60_000;
  const later = await f.broker.create(signed('msgvault.stats', {}, 'trayo', now));
  assert.equal(later.state, 'complete');
  assert.equal(f.ran.length, 2);
  // Revoked by hand, and it is gone.
  f.broker.revokeGrants('all');
  const after = await f.broker.create(signed('msgvault.stats', {}, 'trayo', now));
  assert.equal(after.state, 'pending');
  assert.equal(f.ran.length, 2);
});

/**
 * A DRAFT IS NEVER A STANDING PERMISSION.
 *
 * Reading someone's mail for an hour is a bargain they may want. Writing into
 * their mailbox for an hour, unattended, under their name, is the thing the
 * dialog exists to prevent — and before `timedReadOnly` it would have been
 * bought with one click on a search, because msgvault's full scope now
 * contains the drafts.
 */
test('a draft rides the msgvault grant — it is not re-approved every time', async () => {
  // The owner's call, and the premise it rests on is asserted in
  // msgvault.test.mjs and still true: THERE IS NO SEND. The worst a duration
  // buys is a draft sitting in the owner's mailbox.
  const f = fixture();
  const session = f.pair();
  const read = await ask(f, 'msgvault.search', { query: 'dinner' });
  await f.broker.decideSession(read.id, read.fingerprint, 'approve', {
    duration: '1h',
    scope: 'msgvault-all-v1',
    session,
  });
  assert.equal(f.ran.length, 1);
  // …and now a draft runs on it, with no second dialog.
  const draft = await f.broker.create({
    action: 'msgvault.draft-reply',
    payload: { id: '150889', body: 'Thursday?' },
    origin: 'local',
  });
  assert.equal(draft.state, 'complete');
  assert.deepEqual(f.ran[1], [
    'msgvault.draft-reply',
    { id: '150889', body: 'Thursday?', all: false },
  ]);
  // So does editing and deleting it: the whole lifecycle, one approval.
  for (const [action, payload] of [
    ['msgvault.draft-get', { id: 'd9' }],
    ['msgvault.draft-edit', { id: 'd9', body: 'later' }],
    ['msgvault.draft-delete', { id: 'd9' }],
  ]) {
    assert.equal((await f.broker.create({ action, payload, origin: 'local' })).state, 'complete');
  }
  assert.deepEqual(
    f.ran.slice(2).map(([a]) => a),
    ['msgvault.draft-get', 'msgvault.draft-edit', 'msgvault.draft-delete'],
  );
});

test('with NO grant a draft still stops and shows its text', async () => {
  // Nothing about the blanket approval removes the dialog itself: an agent
  // that has not been approved for msgvault at all still waits for a person,
  // and that person still reads the body before it lands in their mailbox.
  const f = fixture();
  f.pair();
  const draft = await f.broker.create({
    action: 'msgvault.draft-reply',
    payload: { id: '150889', body: 'Thursday?' },
    origin: 'local',
  });
  assert.equal(draft.state, 'pending');
  assert.equal(f.ran.length, 0);
});

test('a live READ grant does not buy a draft', async () => {
  // The failure this guards is quiet: a timed read grant whose scope had
  // widened to msgvault-all-v1 would have dispatched a draft with no dialog.
  const f = fixture({ timedGrants: 'read' });
  const session = f.pair();
  const read = await ask(f, 'msgvault.search', { query: 'dinner' });
  await f.broker.decideSession(read.id, read.fingerprint, 'approve', {
    duration: '1h',
    scope: 'msgvault-read-v1',
    session,
  });
  assert.equal(f.ran.length, 1);
  // Another read rides it…
  assert.equal((await ask(f, 'msgvault.search', { query: 'again' })).state, 'complete');
  assert.equal(f.ran.length, 2);
  // …and a draft does not.
  const draft = await f.broker.create({
    action: 'msgvault.draft-reply',
    payload: { id: '1', body: 'b' },
    origin: 'local',
  });
  assert.equal(draft.state, 'pending');
  assert.equal(f.ran.length, 2);
});

test('a reply draft names the message it answers, all the way through', async () => {
  const f = fixture();
  const session = f.pair();
  const r = await f.broker.create({
    action: 'msgvault.draft-reply',
    payload: { id: '150889', body: 'Yes — Thursday works.', all: true },
    origin: 'local',
  });
  // A duration IS offered now — drafts ride the blanket msgvault approval,
  // which is the owner's call and rests on there being no send verb. What
  // this test is actually about survives unchanged: the message id and the
  // `--all` choice reach the executor exactly as the human saw them.
  assert.equal(r.timedAllowed, true);
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', { session });
  assert.deepEqual(f.ran, [
    ['msgvault.draft-reply', { id: '150889', body: 'Yes — Thursday works.', all: true }],
  ]);
});

/**
 * THE SECOND LOCK ON A READ GRANT.
 *
 * `grantScope` is derived from `timedScope`, and msgvault's timed scope is
 * ALWAYS its read scope. So a draft's scope string is byte-identical to a read
 * grant's: the scope equality this broker leans on everywhere else does not
 * separate a read from a write here. What separates them is the grant's
 * `actions` list — and a list is one edit away from being wrong in the
 * direction nobody notices, because the failure is a write that never asked.
 *
 * So the rule is stated about the ACTION too, and this test is the proof: a
 * grant whose action list has been widened to include the draft — exactly the
 * mistake the guard exists for — still does not buy one.
 */
test('a read grant cannot buy a draft even if its action list says it can', async () => {
  const f = fixture({ timedGrants: 'read' });
  const session = f.pair();
  const read = await ask(f, 'msgvault.search', { query: 'dinner' });
  await f.broker.decideSession(read.id, read.fingerprint, 'approve', {
    duration: '1h',
    scope: 'msgvault-read-v1',
    session,
  });
  assert.equal(f.ran.length, 1);

  // The grant the broker actually minted carries the four reads…
  const [id, minted] = [...f.broker.grants.entries()][0];
  assert.ok(!minted.actions.includes('msgvault.draft-reply'));
  // …and here is the sabotage: widen it, in place, the way a future edit to
  // `actions:` at the mint site would. Taken from the internal map, not from
  // `listGrants()` — that view strips `owner` and `elapsedExpires`, and a
  // copy without them is a grant `activeGrants()` reaps on sight, which
  // would have made this test pass for the wrong reason.
  f.broker.grants.set(
    id,
    Object.freeze({ ...minted, actions: [...minted.actions, 'msgvault.draft-reply'] }),
  );
  assert.deepEqual(
    f.broker.grantScope({ teamID: 'T123', origin: 'local', action: 'msgvault.draft-reply' }),
    f.broker.grantScope({ teamID: 'T123', origin: 'local', action: 'msgvault.search' }),
    'the scope strings are identical — this is why the action rule is needed',
  );

  // A read still rides it, so the grant is genuinely live…
  assert.equal((await ask(f, 'msgvault.search', { query: 'again' })).state, 'complete');
  assert.equal(f.ran.length, 2);
  // …and the draft still stops at a human.
  const draft = await f.broker.create({
    action: 'msgvault.draft-reply',
    payload: { id: '150889', body: 'b' },
    origin: 'local',
  });
  assert.equal(draft.state, 'pending');
  assert.equal(f.ran.length, 2);
});
