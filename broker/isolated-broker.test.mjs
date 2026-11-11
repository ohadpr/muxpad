import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Broker } from './core.mjs';
import { handler } from './http.mjs';
import { HumanSessions, SESSION_COOKIE } from './human-session.mjs';

/**
 * A WHOLE BROKER, ON LOOPBACK, WITH NOTHING REAL BEHIND IT.
 *
 * Every other broker test drives the `Broker` class directly. This one stands
 * the real thing up end to end — the HTTP boundary, the human session, the
 * capability registry, the grant store — on its own port and its own data
 * directory, with a FAKE Slack and a FAKE msgvault runner behind it.
 *
 * It exists because the live broker is the thing that holds the Slack token
 * and raises a dialog on somebody's phone, so "does the new code work" must
 * be answerable without touching it, at an hour when nobody can approve
 * anything. Nothing here reaches the network, the real daemon, or any file
 * outside a temp directory.
 *
 * What it proves, in one place:
 *   · a request runs only after a human decides;
 *   · the capability is derived from the action, end to end;
 *   · a timed grant covers later calls of the SAME capability from the SAME
 *     machine, and nothing else;
 *   · the scope advertised over HTTP is the one that is accepted back.
 */
const secret = 'an-isolated-test-only-pairing-secret-0123456789';
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function isolatedBroker({ hostPolicy } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'broker-isolated-'));
  dirs.push(dataDir);
  let now = 1_000_000;
  const state = {};
  const ran = [];
  const config = {
    origin: 'https://broker.isolated.test',
    rpID: 'broker.isolated.test',
    teamID: 'T_ISOLATED',
    muxpadURL: 'https://muxpad.isolated.test/',
    approvalMode: 'session',
    bootstrapHash: createHash('sha256').update(secret).digest('base64url'),
  };
  const save = () => {};
  const sessions = new HumanSessions({ config, state, save, now: () => now });
  const broker = new Broker({
    // UNSCOPED, INJECTED. The broker reads the host policy itself now, and a
    // test that fell through to the real /Library/muxpad/connectors.json would
    // pass or fail on the state of the machine it runs on.
    hostPolicy: () => hostPolicy ?? { enforce: false, allow: {} },
    config,
    state,
    save,
    now: () => now,
    elapsed: () => now,
    // FAKES. Nothing below this line talks to Slack or to msgvault.
    slack: async (action, payload) => {
      ran.push({ who: 'slack', action, payload });
      return { channel: 'C_FAKE', ts: '1.2' };
    },
    msgvault: async (action, payload) => {
      ran.push({ who: 'msgvault', action, payload });
      return { action, result: { messages: 338_818 } };
    },
  });
  const server = createServer(handler(broker, config.origin, { config, sessions }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  dirs.push(dataDir);
  const url = `http://127.0.0.1:${server.address().port}`;
  const paired = sessions.pair(secret);
  sessions.authenticate(`${SESSION_COOKIE}=${paired.token}`);
  return {
    url,
    ran,
    broker,
    session: state.humanSessions[0],
    tick: (ms) => {
      now += ms;
    },
    close: () => server.close(),
    ask: async (action, payload, origin) => {
      const r = await fetch(`${url}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload, origin }),
      });
      return { status: r.status, body: await r.json() };
    },
  };
}

test('an isolated broker runs nothing until a human decides, per capability', async () => {
  const b = await isolatedBroker();
  try {
    // ── Over HTTP, from "the mini" ──────────────────────────────────────
    const stats = await b.ask('msgvault.stats', {}, 'local');
    assert.equal(stats.status, 202); // queued, never "sent"
    assert.equal(stats.body.state, 'pending');
    assert.deepEqual(b.ran, [], 'the archive was read before anybody approved');

    // The scope it ADVERTISES is the archive's, not Slack's.
    assert.equal(stats.body.timedScope, 'msgvault-all-v1');
    assert.equal(stats.body.origin, 'local');

    // ── A human approves it, for an hour ────────────────────────────────
    const out = await b.broker.decideSession(stats.body.id, stats.body.fingerprint, 'approve', {
      duration: '1h',
      // …and the scope it advertised is the one accepted back. Sending a
      // hardcoded Slack scope here is what the web client used to do.
      scope: stats.body.timedScope,
      session: b.session,
    });
    assert.equal(out.state, 'complete');
    assert.deepEqual(b.ran.map((r) => r.who), ['msgvault']);

    // TWO INDEPENDENT REASONS A SLACK CALL CANNOT RIDE THIS, both asserted.
    // Grant matching needs the action list AND the scope to agree, so each
    // one alone hides a widening of the other — which is exactly what
    // happened when the scope was made capability-aware and the action list
    // was not, and again in reverse.
    const [grant] = b.broker.listGrants();
    assert.ok(
      grant.actions.every((a) => a.startsWith('msgvault.')),
      `a timed archive grant covers ${grant.actions.filter((a) => !a.startsWith('msgvault.'))}`,
    );
    assert.equal(grant.permissionScope, 'msgvault-all-v1');
    assert.equal(grant.origin, 'local');

    // ── Inside the window, the same capability from the same machine runs
    const search = await b.ask('msgvault.search', { query: 'from:a@b.com' }, 'local');
    assert.equal(search.body.state, 'complete');
    assert.equal(b.ran.length, 2);
    // and the payload reached the runner validated, with its default applied
    assert.deepEqual(b.ran[1].payload, { query: 'from:a@b.com', limit: 50 });

    // ── The grant buys NOTHING for Slack …
    const post = await b.ask('slack.channels', {}, 'local');
    assert.equal(post.body.state, 'pending');
    assert.equal(b.ran.length, 2);

    // ── … and nothing from another machine
    const fromVm = await b.ask('msgvault.stats', {}, 'trayo');
    assert.equal(fromVm.body.state, 'pending');
    assert.equal(b.ran.length, 2);

    // ── An unregistered verb never reaches a validator or a runner
    for (const action of ['msgvault.query', 'msgvault.draft-compose', 'msgvault.export-messages']) {
      const r = await b.ask(action, {}, 'local');
      assert.equal(r.status, 400, action);
    }
    assert.equal(b.ran.length, 2);

    // ── And the window closes
    b.tick(3_600_001);
    const later = await b.ask('msgvault.stats', {}, 'local');
    assert.equal(later.body.state, 'pending', 'a grant outlived its hour');
    assert.equal(b.ran.length, 2);
  } finally {
    b.close();
  }
});

test('an isolated broker refuses a lasting permission it cannot attribute', async () => {
  // `origin` is a string the caller chooses, `/requests` has no caller
  // authentication, and every request reaches this broker from the same
  // machine as the agents it restrains. A grant bound to `trayo` would
  // therefore be spendable by anything on the mini willing to type
  // `"origin":"trayo"` — unless that machine PROVES it asked, which this one
  // does not: a real broker has no key for `trayo` under /Library/muxpad, so
  // this is the unproven path end to end, through HTTP.
  const b = await isolatedBroker();
  try {
    const remote = await b.ask('slack.channels', {}, 'trayo');
    assert.equal(remote.body.timedAllowed, false);
    assert.match(remote.body.timedRefusedReason, /did not prove it/);
    await assert.rejects(
      b.broker.decideSession(remote.body.id, remote.body.fingerprint, 'approve', {
        duration: '1h',
        scope: remote.body.timedScope,
        session: b.session,
      }),
      /can only be approved once/,
    );
    assert.equal(b.ran.length, 0);
    // Approving it ONCE still works, and runs exactly once.
    await b.broker.decideSession(remote.body.id, remote.body.fingerprint, 'approve', {
      session: b.session,
    });
    assert.equal(b.ran.length, 1);
    assert.equal(b.broker.listGrants().length, 0, 'a remote approval minted a grant');

    // `local` may hold one, because the request did come from this machine —
    // and the scope still keeps another machine's request from finding it.
    const here = await b.ask('slack.channels', {}, 'local');
    assert.equal(here.body.timedAllowed, true);
    await b.broker.decideSession(here.body.id, here.body.fingerprint, 'approve', {
      duration: '1h',
      scope: here.body.timedScope,
      session: b.session,
    });
    assert.equal(b.ran.length, 2);
    assert.equal((await b.ask('slack.channels', {}, 'local')).body.state, 'complete');
    assert.equal((await b.ask('slack.channels', {}, 'trayo')).body.state, 'pending');
    assert.equal((await b.ask('slack.channels', {})).body.state, 'pending');
    assert.equal(b.ran.length, 3);
  } finally {
    b.close();
  }
});

test('an isolated broker enforces the host policy itself', async () => {
  // muxpad checks connectors.json before sending; so must the broker, because
  // `/requests` is reachable without going through muxpad at all. A review
  // found the one component meant to hold against agents had never read the
  // rule it was meant to hold.
  const b = await isolatedBroker({
    hostPolicy: { enforce: true, allow: { slack: ['trayo'], msgvault: ['local'] } },
  });
  try {
    // Allowed by the policy.
    assert.equal((await b.ask('msgvault.stats', {}, 'local')).body.state, 'pending');
    assert.equal((await b.ask('slack.channels', {}, 'trayo')).body.state, 'pending');

    // Refused BY THE BROKER, over HTTP, before anything is created.
    for (const [action, origin, re] of [
      ['slack.channels', 'local', /slack is scoped to trayo/],
      ['msgvault.stats', 'trayo', /msgvault is scoped to local/],
      ['slack.channels', undefined, /is from unknown/],
    ]) {
      // Over HTTP the reason is deliberately generic — the boundary does not
      // narrate the broker's internals to its caller, and muxpad's own gate
      // is what produces the readable sentence an agent repeats.
      const r = await b.ask(action, {}, origin);
      assert.equal(r.status, 400, `${action}/${origin}`);
      assert.match(JSON.stringify(r.body), /refused or invalid/);
      // The reason itself is asserted where it exists.
      await assert.rejects(b.broker.create({ action, payload: {}, origin }), re);
    }
    assert.deepEqual(b.ran, []);
  } finally {
    b.close();
  }
});

test('an unreadable policy refuses every capability', async () => {
  const b = await isolatedBroker({
    hostPolicy: { enforce: false, allow: {}, problem: 'connector policy unreadable: EACCES' },
  });
  try {
    for (const action of ['slack.channels', 'msgvault.stats']) {
      assert.equal((await b.ask(action, {}, 'local')).status, 400, action);
      await assert.rejects(
        b.broker.create({ action, payload: {}, origin: 'local' }),
        /unreadable/,
        action,
      );
    }
    assert.deepEqual(b.ran, []);
  } finally {
    b.close();
  }
});
