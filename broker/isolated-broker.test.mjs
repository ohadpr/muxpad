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

async function isolatedBroker() {
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
    assert.equal(stats.body.timedScope, 'msgvault-read-v1');
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
    assert.equal(grant.permissionScope, 'msgvault-read-v1');
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

test('an isolated broker binds a Slack grant to the machine that asked', async () => {
  const b = await isolatedBroker();
  try {
    const first = await b.ask('slack.channels', {}, 'trayo');
    assert.equal(first.body.timedScope, 'slack-team-all-v2');
    await b.broker.decideSession(first.body.id, first.body.fingerprint, 'approve', {
      duration: '1h',
      scope: first.body.timedScope,
      session: b.session,
    });
    assert.equal(b.ran.length, 1);

    // Same verb, same hour, different machine → back to the human.
    assert.equal((await b.ask('slack.channels', {}, 'local')).body.state, 'pending');
    assert.equal(b.ran.length, 1);
    // Same machine → rides the grant.
    assert.equal((await b.ask('slack.channels', {}, 'trayo')).body.state, 'complete');
    assert.equal(b.ran.length, 2);
    // An unnamed origin never matches a grant minted for a named one.
    assert.equal((await b.ask('slack.channels', {})).body.state, 'pending');
    assert.equal(b.ran.length, 2);
  } finally {
    b.close();
  }
});
