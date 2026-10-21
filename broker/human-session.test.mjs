import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Broker } from './core.mjs';
import { handler } from './http.mjs';
import { HumanSessions, SESSION_COOKIE, validateHumanConfig } from './human-session.mjs';

const secret = 'a-long-random-test-only-pairing-secret-12345';
const origin = 'https://approve.example.test';
function fixture() {
  let now = 1000;
  let elapsed = 0;
  const state = {};
  const calls = [];
  const config = {
    origin,
    rpID: 'approve.example.test',
    teamID: 'T123',
    muxpadURL: 'https://muxpad.example.test/',
    approvalMode: 'session',
    bootstrapHash: createHash('sha256').update(secret).digest('base64url'),
  };
  const saves = [];
  const save = (value) => saves.push(structuredClone(value));
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
    return { cookie, csrf: sessions.authenticate(cookie).csrf };
  };
  return {
    advanceWall: (ms) => {
      now += ms;
    },
    advanceElapsed: (ms) => {
      elapsed += ms;
    },
    sessions,
    broker,
    state,
    config,
    calls,
    saves,
    pair,
    advance: (ms) => {
      now += ms;
      elapsed += Math.max(0, ms);
    },
  };
}
const request = (f) =>
  f.broker.create({
    action: 'slack.post',
    payload: { ref: 'C123', text: 'Exact message <script>never execute</script>' },
  });

test('one-time pairing grants a random session, persists no raw bearer, and requires the right CSRF token', () => {
  const f = fixture();
  assert.throws(() => f.sessions.pair('wrong'));
  const { cookie, csrf } = f.pair();
  assert.ok(f.sessions.authorize(cookie, csrf));
  assert.equal(f.sessions.authorize(cookie, 'forged'), null);
  assert.equal(f.sessions.authenticate(`${SESSION_COOKIE}=forged`), null);
  assert.equal(f.sessions.authenticate(`${cookie}; ${cookie}`), null);
  assert.ok(!JSON.stringify(f.state).includes(cookie.split('=')[1]));
  assert.throws(() => f.sessions.pair(secret));
});
test('pairing is rate limited and failed persistence does not create an authorized browser', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) assert.throws(() => f.sessions.pair('wrong'));
  assert.throws(() => f.sessions.pair(secret));
  f.advance(900_001);
  f.sessions.save = () => {
    throw Error('disk full');
  };
  assert.throws(() => f.sessions.pair(secret));
  assert.equal(f.state.humanPaired, undefined);
});
test('logout revokes the server-side session and it cannot be re-created using the old bootstrap secret', () => {
  const f = fixture();
  const { cookie, csrf } = f.pair();
  f.sessions.logout(cookie, csrf);
  assert.equal(f.sessions.authenticate(cookie), null);
  assert.throws(() => f.sessions.pair(secret));
});
test('sessions expire even when a browser keeps the cookie', () => {
  const f = fixture();
  const { cookie } = f.pair();
  f.advance(31 * 86400_000);
  assert.equal(f.sessions.authenticate(cookie), null);
});
test('a separate protected hostname is mandatory: ports cannot isolate cookies', () => {
  const f = fixture();
  assert.doesNotThrow(() => validateHumanConfig(f.config));
  for (const muxpadURL of [
    'https://approve.example.test:7777/',
    'http://muxpad.example.test/',
    'https://user:pass@muxpad.example.test/',
  ]) {
    assert.throws(() => validateHumanConfig({ ...f.config, muxpadURL }));
  }
  assert.throws(() => validateHumanConfig({ approvalMode: 'misspelled' }));
});
test('session decisions are bound to the immutable displayed request and consumed once under concurrency', async () => {
  const f = fixture();
  f.pair();
  const r = await request(f);
  await assert.rejects(f.broker.decideSession(r.id, 'wrong-fingerprint', 'approve'));
  assert.equal(f.calls.length, 0);
  const decisions = await Promise.allSettled([
    f.broker.decideSession(r.id, r.fingerprint, 'approve'),
    f.broker.decideSession(r.id, r.fingerprint, 'approve'),
  ]);
  assert.equal(decisions.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(f.calls, [
    ['slack.post', { channel: 'C123', text: '🤖 Exact message <script>never execute</script>' }],
  ]);
  assert.equal(f.saves.at(-1).lastDecision.mode, 'session');
});
test('stale, changed, rejected and failed-to-persist requests never execute', async () => {
  const f = fixture();
  f.pair();
  let r = await request(f);
  const other = await request(f);
  await assert.rejects(f.broker.decideSession(other.id, r.fingerprint, 'approve'));
  assert.equal((await f.broker.decideSession(r.id, r.fingerprint, 'reject')).state, 'rejected');
  r = await request(f);
  f.advance(300_001);
  await assert.rejects(f.broker.decideSession(r.id, r.fingerprint, 'approve'));
  r = await request(f);
  f.broker.save = () => {
    throw Error('disk full');
  };
  assert.equal((await f.broker.decideSession(r.id, r.fingerprint, 'approve')).state, 'failed');
  assert.equal(f.calls.length, 0);
});

async function serve(f, run) {
  const server = createServer(
    handler(f.broker, origin, { config: f.config, sessions: f.sessions }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const api = (path, body, headers = {}) =>
    fetch(`${url}${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { 'content-type': 'application/json', ...headers },
    });
  try {
    await run(api);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
test('an agent cannot self-approve using an Origin header, request ID, forged cookie or CSRF token', async () => {
  const f = fixture();
  const { cookie, csrf } = f.pair();
  const r = await request(f);
  await serve(f, async (api) => {
    const body = { id: r.id, fingerprint: r.fingerprint, decision: 'approve' };
    for (const headers of [
      { Origin: origin },
      { Origin: origin, Cookie: 'fake=1', 'x-muxpad-csrf': csrf },
      { Origin: origin, Cookie: cookie },
      { Origin: origin, Cookie: cookie, 'x-muxpad-csrf': 'fake' },
      { Cookie: cookie, 'x-muxpad-csrf': csrf },
      { Origin: 'https://muxpad.example.test', Cookie: cookie, 'x-muxpad-csrf': csrf },
    ]) {
      const response = await api('/human/decision', body, headers);
      assert.ok([401, 403].includes(response.status));
      assert.equal(f.calls.length, 0);
    }
    // Public status contains no human token, and spoofing a mode on the legacy
    // endpoint does not bypass the human-session gate.
    const status = await (await api(`/requests/${r.id}`)).text();
    assert.ok(!status.includes(csrf));
    assert.ok(!status.includes(cookie));
    assert.equal(
      (await api(`/requests/${r.id}/decision`, { response: { mode: 'session', approved: true } }))
        .status,
      400,
    );
    assert.equal(f.calls.length, 0);
    const approved = await api('/human/decision', body, {
      Origin: origin,
      Cookie: cookie,
      'x-muxpad-csrf': csrf,
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).state, 'complete');
    assert.equal(f.calls.length, 1);
    assert.equal(
      (
        await api('/human/decision', body, {
          Origin: origin,
          Cookie: cookie,
          'x-muxpad-csrf': csrf,
        })
      ).status,
      400,
    );
    assert.equal(f.calls.length, 1);
  });
});
test('the human queue and session endpoints cannot leak credentials to the agent or muxpad iframe', async () => {
  const f = fixture();
  const { cookie } = f.pair();
  await request(f);
  await serve(f, async (api) => {
    assert.equal((await api('/human/session')).status, 401);
    assert.equal((await api('/human/pending')).status, 401);
    const response = await api('/human/session', undefined, { Cookie: cookie });
    const data = await response.json();
    assert.ok(data.csrf);
    assert.equal(data.config.muxpadURL, f.config.muxpadURL);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const shell = await (await api('/')).text();
    assert.match(shell, /<dialog id="approval"/);
    assert.match(
      shell,
      /sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"/,
    );
    assert.ok(!shell.includes('allow-top-navigation'));
  });
});
test('pairing sets a host-only secure HttpOnly cookie only from the protected origin', async () => {
  const f = fixture();
  await serve(f, async (api) => {
    assert.equal((await api('/human/pair', { secret })).status, 403);
    const response = await api('/human/pair', { secret }, { Origin: origin });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^__Host-muxpad-human=/);
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'])
      assert.ok(cookie.includes(flag));
    assert.ok(!cookie.includes('Domain='));
    assert.deepEqual(await response.json(), { paired: true });
    assert.equal((await api('/human/pair', { secret }, { Origin: origin })).status, 400);
  });
});

async function allowTimed(f, duration = '10m') {
  const { cookie, csrf } = f.pair();
  const session = f.sessions.authenticate(cookie);
  const r = await request(f);
  const result = await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration,
    scope: duration === 'once' ? undefined : 'slack-team-all-v2',
    session,
  });
  return { cookie, csrf, session, result };
}
test('timed approval allows future supported actions across destinations in the configured team', async () => {
  const f = fixture();
  const { result } = await allowTimed(f);
  assert.equal(result.state, 'complete');
  assert.ok(result.grantID);
  const again = await f.broker.create({
    action: 'slack.post',
    payload: { ref: 'C123', text: 'Different message, same permitted scope' },
  });
  assert.equal(again.state, 'complete');
  assert.equal(again.grantID, result.grantID);
  assert.equal(f.calls.length, 2);
  assert.equal(f.state.lastDecision.mode, 'timed-grant');
  assert.equal(f.state.lastDecision.grantID, result.grantID);
  assert.equal(
    (
      await f.broker.create({
        action: 'slack.post',
        payload: { ref: 'C456', text: 'Other channel' },
      })
    ).state,
    'complete',
  );
  assert.equal(
    (await f.broker.create({ action: 'slack.unpost', payload: { ref: 'C123', ts: '1.2' } })).state,
    'complete',
  );
  assert.equal(
    (await f.broker.create({ action: 'slack.read', payload: { ref: 'C123' } })).state,
    'complete',
  );
  f.config.teamID = 'T_OTHER';
  assert.equal((await request(f)).state, 'pending');
});
test('approve once never creates a timed permission and agents cannot request their own duration', async () => {
  const f = fixture();
  f.pair();
  const r = await f.broker.create({
    action: 'slack.post',
    payload: { ref: 'C123', text: 'hello', duration: '1d' },
    duration: '1d',
    scope: 'slack-team-all-v2',
    approved: true,
  });
  assert.equal(r.state, 'pending');
  assert.equal((await f.broker.decideSession(r.id, r.fingerprint, 'approve')).state, 'complete');
  assert.deepEqual(f.broker.listGrants(), []);
  assert.equal((await request(f)).state, 'pending');
});
test('server enforces finite duration presets and session authority for timed permissions', async () => {
  const f = fixture();
  const { cookie } = f.pair();
  const r = await request(f);
  const session = f.sessions.authenticate(cookie);
  for (const duration of ['forever', '100d', 600000, null, '__proto__'])
    await assert.rejects(
      f.broker.decideSession(r.id, r.fingerprint, 'approve', { duration, session }),
    );
  await assert.rejects(f.broker.decideSession(r.id, r.fingerprint, 'approve', { duration: '10m' }));
  await assert.rejects(
    f.broker.decideSession(r.id, r.fingerprint, 'reject', {
      duration: '1d',
      scope: 'slack-team-all-v2',
      session,
    }),
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.broker.listGrants(), []);
});
test('timed expiry is enforced by the broker clock at the exact expiry boundary', async () => {
  const f = fixture();
  await allowTimed(f);
  f.advance(600_000);
  assert.deepEqual(f.broker.listGrants(), []);
  assert.equal((await request(f)).state, 'pending');
  assert.equal(f.calls.length, 1);
});
test('one-day permission is clamped to human session expiry and never survives restart or logout', async () => {
  const f = fixture();
  f.config.sessionLifetimeMs = 3600_000;
  const { cookie, csrf } = await allowTimed(f, '1d');
  assert.equal(f.broker.listGrants()[0].expires, 3601_000);
  const replacement = new Broker({
    config: f.config,
    state: f.state,
    save: () => {},
    slack: async () => {
      throw Error('must not run');
    },
    now: () => 1000,
  });
  assert.deepEqual(replacement.listGrants(), []);
  assert.equal((await request({ broker: replacement })).state, 'pending');
  assert.equal(f.state.grants, undefined);
  f.sessions.logout(cookie, csrf);
  assert.deepEqual(f.broker.listGrants(), []);
});
test('revoke prevents new automatic dispatch while already queued requests remain pending', async () => {
  const f = fixture();
  f.pair();
  const older = await request(f);
  const r = await request(f);
  const session = f.state.humanSessions[0];
  const result = await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '1h',
    scope: 'slack-team-all-v2',
    session,
  });
  assert.equal(f.broker.view(older.id).state, 'pending');
  assert.equal(f.calls.length, 1);
  f.broker.revokeGrants(result.grantID);
  assert.equal((await request(f)).state, 'pending');
  assert.equal(f.calls.length, 1);
});
test('failed initial Slack execution and failed audit persistence do not grant future access', async () => {
  const f = fixture();
  f.pair();
  const r = await request(f);
  f.broker.slack = async () => {
    throw Error('uncertain upstream');
  };
  assert.equal(
    (
      await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
        duration: '10m',
        scope: 'slack-team-all-v2',
        session: f.state.humanSessions[0],
      })
    ).state,
    'failed',
  );
  assert.deepEqual(f.broker.listGrants(), []);
  const other = fixture();
  await allowTimed(other);
  other.broker.save = () => {
    throw Error('disk full');
  };
  assert.equal((await request(other)).state, 'failed');
  assert.equal(other.calls.length, 1);
});
for (const termination of ['logout', 'revoke'])
  test(`${termination} during the initial in-flight action prevents late grant activation`, async () => {
    const f = fixture();
    const { cookie, csrf } = f.pair();
    const session = f.sessions.authenticate(cookie);
    const r = await request(f);
    let finish;
    f.broker.slack = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const deciding = f.broker.decideSession(r.id, r.fingerprint, 'approve', {
      duration: '10m',
      scope: 'slack-team-all-v2',
      session,
    });
    assert.equal(typeof finish, 'function');
    if (termination === 'logout') f.sessions.logout(cookie, csrf);
    else f.broker.revokeGrants('all');
    finish({ channel: 'C123', ts: '1.2' });
    assert.equal((await deciding).state, 'complete');
    assert.deepEqual(f.broker.listGrants(), []);
  });
test('full-team timed permission includes different queries and result limits', async () => {
  const f = fixture();
  f.pair();
  const r = await f.broker.create({
    action: 'slack.search',
    payload: { query: 'in:general project', limit: 5 },
  });
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '10m',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  assert.equal(
    (
      await f.broker.create({
        action: 'slack.search',
        payload: { query: 'in:general project', limit: 5 },
      })
    ).state,
    'complete',
  );
  assert.equal(
    (
      await f.broker.create({
        action: 'slack.search',
        payload: { query: 'in:general project', limit: 100 },
      })
    ).state,
    'complete',
  );
  assert.equal(
    (await f.broker.create({ action: 'slack.search', payload: { query: 'all', limit: 5 } })).state,
    'complete',
  );
});
test('timed decisions and revocation retain the human-only HTTP authorization boundary', async () => {
  const f = fixture();
  const { cookie, csrf } = f.pair();
  const r = await request(f);
  await serve(f, async (api) => {
    const body = {
      id: r.id,
      fingerprint: r.fingerprint,
      decision: 'approve',
      duration: '1d',
      scope: 'slack-team-all-v2',
    };
    assert.equal((await api('/human/decision', body, { Origin: origin })).status, 401);
    assert.equal((await api('/human/grants')).status, 401);
    const headers = { Origin: origin, Cookie: cookie, 'x-muxpad-csrf': csrf };
    const approved = await api('/human/decision', body, headers);
    assert.equal(approved.status, 200);
    const listing = await api('/human/grants', undefined, { Cookie: cookie });
    const list = await listing.json();
    assert.equal(list.grants.length, 1);
    assert.equal(list.grants[0].owner, undefined);
    assert.equal(
      (await api('/human/grants/revoke', { id: 'all' }, { Origin: origin })).status,
      401,
    );
    assert.equal(f.broker.listGrants().length, 1);
    assert.equal((await api('/human/grants/revoke', { id: 'all' }, headers)).status, 200);
    assert.deepEqual(f.broker.listGrants(), []);
  });
});

test('permission duration starts at approval, and audit delays cannot dispatch past its expiry', async () => {
  const f = fixture();
  f.pair();
  const r = await request(f);
  let finish;
  f.broker.slack = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const deciding = f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '10m',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  f.advance(30_000);
  finish({ channel: 'C123', ts: '1.2' });
  await deciding;
  assert.equal(f.broker.listGrants()[0].expires, 601_000);
  f.advance(569_999);
  f.broker.save = () => {
    f.advance(2);
  };
  const next = await request(f);
  assert.equal(next.state, 'pending');
  assert.equal(f.broker.listGrants().length, 0);
});

test('full-team scope safely supports different Unicode search queries', async () => {
  const f = fixture();
  f.pair();
  const first = await f.broker.create({
    action: 'slack.search',
    payload: { query: 'é', limit: 5 },
  });
  await f.broker.decideSession(first.id, first.fingerprint, 'approve', {
    duration: '10m',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  assert.equal(
    (await f.broker.create({ action: 'slack.search', payload: { query: 'a', limit: 5 } })).state,
    'complete',
  );
});

test('initial dispatch fails closed when persistence crosses request or session expiry', async () => {
  for (const boundary of ['request', 'session']) {
    const f = fixture();
    f.pair();
    const r = await request(f);
    const session = f.state.humanSessions[0];
    if (boundary === 'session') session.expires = 1001;
    f.broker.save = () => f.advance(boundary === 'request' ? 300_001 : 2);
    const result = await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
      duration: '10m',
      scope: 'slack-team-all-v2',
      session,
    });
    assert.equal(result.state, 'failed');
    assert.equal(f.calls.length, 0);
    assert.equal(f.broker.listGrants().length, 0);
  }
});

test('backward clock correction invalidates timed authority', async () => {
  const f = fixture();
  f.pair();
  const r = await request(f);
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '10m',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  f.advance(100);
  assert.equal(f.broker.listGrants().length, 1);
  f.advance(-1);
  assert.equal((await request(f)).state, 'pending');
  assert.equal(f.broker.listGrants().length, 0);
  assert.equal(f.calls.length, 1);
});

test('automatic request cannot dispatch after its own expiry during persistence', async () => {
  const f = fixture();
  f.pair();
  const r = await request(f);
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '1d',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  f.broker.save = () => f.advance(300_001);
  assert.equal((await request(f)).state, 'expired');
  assert.equal(f.calls.length, 1);
});

test('sparse observations cannot hide rollback or suspend beyond timed deadline', async () => {
  for (const duration of ['10m', '1d']) {
    const f = fixture();
    f.pair();
    const r = await request(f);
    await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
      duration,
      scope: duration === 'once' ? undefined : 'slack-team-all-v2',
      session: f.state.humanSessions[0],
    });
    f.advanceWall(300_000);
    f.advanceElapsed(duration === '10m' ? 660_000 : 86_400_001);
    assert.equal((await request(f)).state, 'pending');
    assert.equal(f.broker.listGrants().length, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('initial in-flight success cannot activate a permission after elapsed deadline', async () => {
  const f = fixture();
  f.pair();
  const r = await request(f);
  f.broker.slack = async () => {
    f.advanceElapsed(600_001);
    return {};
  };
  const result = await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '10m',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  assert.equal(result.state, 'complete');
  assert.equal(f.broker.listGrants().length, 0);
  assert.ok(result.grantWarning);
});

test('elapsed session cap prevents sparse rollback extending an active one-day grant', async () => {
  const f = fixture();
  f.pair();
  f.state.humanSessions[0].expires = 3_601_000;
  const r = await request(f);
  await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '1d',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  f.advanceWall(1_800_000);
  f.advanceElapsed(7_200_000);
  assert.equal((await request(f)).state, 'pending');
  assert.equal(f.broker.listGrants().length, 0);
  assert.equal(f.calls.length, 1);
});

test('delayed initial success cannot activate beyond elapsed remaining session lifetime', async () => {
  const f = fixture();
  f.pair();
  f.state.humanSessions[0].expires = 61_000;
  const r = await request(f);
  f.broker.slack = async () => {
    f.advanceWall(30_000);
    f.advanceElapsed(120_000);
    return {};
  };
  const result = await f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '1d',
    scope: 'slack-team-all-v2',
    session: f.state.humanSessions[0],
  });
  assert.equal(result.state, 'complete');
  assert.ok(result.grantWarning);
  assert.equal(f.broker.listGrants().length, 0);
});

const supportedInputs = [
  ['slack.channels', {}],
  ['slack.read', { ref: 'C456', limit: 25 }],
  ['slack.search', { query: 'different query anywhere', limit: 10 }],
  ['slack.post', { ref: 'C456', text: 'Different message' }],
  ['slack.unpost', { ref: 'C456', ts: '2.3' }],
];
test('explicit timed channel listing permits exactly all five actions for this team without sweeping queued requests', async () => {
  const f = fixture();
  const { cookie } = f.pair();
  const queued = await request(f);
  const listing = await f.broker.create({ action: 'slack.channels', payload: {} });
  const approved = await f.broker.decideSession(listing.id, listing.fingerprint, 'approve', {
    duration: '10m',
    scope: 'slack-team-all-v2',
    session: f.sessions.authenticate(cookie),
  });
  assert.equal(approved.state, 'complete');
  assert.equal(f.broker.view(queued.id).state, 'pending');
  assert.equal(f.calls.length, 1);
  for (const [action, payload] of supportedInputs) {
    const result = await f.broker.create({ action, payload });
    assert.equal(result.state, 'complete', action);
    assert.equal(result.grantID, approved.grantID);
  }
  assert.deepEqual(f.broker.listGrants()[0].actions, [
    'slack.post',
    'slack.unpost',
    'slack.read',
    'slack.search',
    'slack.channels',
    'slack.users',
    'slack.dm',
    'slack.thread',
    'slack.react',
    'slack.edit',
    'slack.upload',
  ]);
  assert.equal(f.broker.listGrants()[0].permissionScope, 'slack-team-all-v2');
  assert.equal(f.broker.listGrants()[0].teamID, 'T123');
  await assert.rejects(f.broker.create({ action: 'slack.future-admin-action', payload: {} }));
  f.config.teamID = 'T_OTHER';
  for (const [action, payload] of supportedInputs)
    assert.equal((await f.broker.create({ action, payload })).state, 'pending', action);
  assert.equal(f.broker.view(queued.id).teamID, 'T123');
  await assert.rejects(f.broker.decideSession(queued.id, queued.fingerprint, 'approve'));
});

test('missing/unknown timed scope and scope-once combinations fail before consuming or dispatching', async () => {
  const f = fixture();
  f.pair();
  const r = await request(f);
  for (const options of [
    { duration: '10m' },
    { duration: '1h', scope: 'old-channel-scope' },
    { duration: '1d', scope: null },
    { duration: 'once', scope: 'slack-team-all-v2' },
  ]) {
    await assert.rejects(
      f.broker.decideSession(r.id, r.fingerprint, 'approve', {
        ...options,
        session: f.state.humanSessions[0],
      }),
    );
    assert.equal(f.broker.view(r.id).state, 'pending');
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.broker.listGrants(), []);
  const forged = await f.broker.create({
    action: 'slack.channels',
    payload: { scope: 'slack-team-all-v2', duration: '1d' },
    scope: 'slack-team-all-v2',
    duration: '1d',
  });
  assert.equal(forged.state, 'pending');
  await f.broker.decideSession(forged.id, forged.fingerprint, 'approve');
  assert.deepEqual(f.broker.listGrants(), []);
});

test('HTTP duration-only cached clients cannot silently obtain broader timed access', async () => {
  const f = fixture();
  const { cookie, csrf } = f.pair();
  const r = await request(f);
  await serve(f, async (api) => {
    const response = await api(
      '/human/decision',
      { id: r.id, fingerprint: r.fingerprint, decision: 'approve', duration: '10m' },
      { Origin: origin, Cookie: cookie, 'x-muxpad-csrf': csrf },
    );
    assert.equal(response.status, 400);
    assert.equal(f.broker.view(r.id).state, 'pending');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.broker.listGrants(), []);
  });
});

test('team-wide grants never override channel policy, including changes during the audit write', async () => {
  const f = fixture();
  await allowTimed(f);
  f.config.channels = ['C123'];
  await assert.rejects(
    f.broker.create({ action: 'slack.post', payload: { ref: 'C456', text: 'Forbidden' } }),
  );
  await assert.rejects(
    f.broker.create({ action: 'slack.search', payload: { query: 'Forbidden' } }),
  );
  f.broker.save = () => {
    f.config.channels = ['C999'];
  };
  const result = await f.broker.create({
    action: 'slack.post',
    payload: { ref: 'C123', text: 'Denied after audit' },
  });
  assert.equal(result.state, 'failed');
  assert.equal(f.calls.length, 1);
});

for (const boundary of ['expiry', 'revoke', 'logout', 'restart'])
  test(`full-team grant stops all supported actions after ${boundary}`, async () => {
    const f = fixture();
    const { cookie, csrf } = await allowTimed(f);
    if (boundary === 'expiry') f.advance(600_000);
    if (boundary === 'revoke') f.broker.revokeGrants('all');
    if (boundary === 'logout') f.sessions.logout(cookie, csrf);
    const broker =
      boundary === 'restart'
        ? new Broker({
            config: f.config,
            state: f.state,
            save: () => {},
            slack: () => {
              throw Error('must not execute');
            },
          })
        : f.broker;
    for (const [action, payload] of supportedInputs)
      assert.equal((await broker.create({ action, payload })).state, 'pending', action);
    assert.equal(f.calls.length, 1);
  });
