import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { Broker } from './core.mjs';
import { handler } from './http.mjs';
import { HumanSessions, SESSION_COOKIE, validateHumanConfig } from './human-session.mjs';
import { PEER_HEADER, parseNodePolicy, verifiedPeer } from './node-policy.mjs';
import { NodeSessions } from './node-session.mjs';
const origin = 'https://secure.example.ts.net';
function fixture() {
  let now = 1000;
  let elapsed = 1000;
  let policy = parseNodePolicy(
    JSON.stringify({
      version: 1,
      revision: 'epoch1',
      hostNodeID: 'host',
      brokerNodeID: 'broker',
      tailnetID: 'tailnet1',
      controlURL: 'https://controlplane.tailscale.com',
      capability: 'muxpad.org/cap/approve-member-v1',
    }),
  );
  const peer = {
    nodeID: 'phone',
    ownerID: '42',
    authorizationID: 'epoch1',
    policy: policy.digest,
    ip: '100.64.0.2',
    generation: 'generation1',
  };
  const laptop = { ...peer, nodeID: 'laptop', ip: '100.64.0.3' };
  const config = {
    origin,
    rpID: 'secure.example.ts.net',
    teamID: 'T123',
    muxpadURL: 'https://app.example.ts.net/',
    approvalMode: 'session',
    authMode: 'tailnet-peer',
    transport: 'tsnet',
  };
  const state = {};
  const calls = [];
  const sessions = new NodeSessions({
    config,
    state,
    save: () => {},
    now: () => now,
    elapsed: () => elapsed,
    policy: () => {
      if (policy instanceof Error) throw policy;
      return policy;
    },
    check: async () => true,
  });
  const broker = new Broker({
    config,
    state,
    save: () => {},
    now: () => now,
    elapsed: () => now,
    slack: async (a, p) => {
      calls.push([a, p]);
      return {};
    },
    sessionLive: (s) => sessions.isLive(s),
    ownerAuthorized: (s) => sessions.ownerAuthorized(s),
  });
  const issue = (p = peer) => {
    const issued = sessions.issue(p);
    const cookie = `${SESSION_COOKIE}=${issued.token}`;
    return { cookie, session: sessions.authenticate(cookie, p) };
  };
  return {
    config,
    state,
    sessions,
    broker,
    peer,
    laptop,
    calls,
    issue,
    setPolicy: (p) => {
      policy = p;
    },
    policy: () => policy,
    advanceElapsed: (ms) => {
      elapsed += ms;
    },
    advance: (ms) => {
      now += ms;
      elapsed += Math.max(0, ms);
    },
  };
}
const pending = (f) =>
  f.broker.create({ action: 'slack.post', payload: { ref: 'C123', text: 'Exact immutable text' } });
const approve = (f, r, session) =>
  f.broker.decideSession(r.id, r.fingerprint, 'approve', {
    duration: '10m',
    scope: 'slack-team-all-v2',
    session,
  });
async function serve(f, run, tcp = false) {
  const dir = mkdtempSync('/private/tmp/mux-node-test-');
  const socketPath = `${dir}/http.sock`;
  const server = createServer(
    handler(f.broker, origin, { config: f.config, sessions: f.sessions }),
  );
  if (tcp) server.listen(0, '127.0.0.1');
  else server.listen(socketPath);
  await once(server, 'listening');
  const api = (path, { body, peer = f.peer, cookie, csrf, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const encoded = peer && Buffer.from(JSON.stringify(peer)).toString('base64url');
      const req = request(
        {
          ...(tcp ? { host: '127.0.0.1', port: server.address().port } : { socketPath }),
          path,
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(peer ? { [PEER_HEADER]: encoded } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json', origin }),
            ...(cookie ? { cookie } : {}),
            ...(csrf ? { 'x-muxpad-csrf': csrf } : {}),
            ...headers,
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (s) => {
            raw += s;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              raw,
              data: () => JSON.parse(raw),
              cookie: res.headers['set-cookie']?.[0]?.split(';')[0],
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const boot = async () => {
    const issued = await api('/human/node/session', { body: {} });
    const first = await api('/human/session', { cookie: issued.cookie });
    return { ...first, cookie: issued.cookie, headers: { ...first.headers, ...issued.headers } };
  };
  try {
    await run(api, boot);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true });
  }
}
test('peer mode requires protected transport; malformed policies, host/self and duplicate identities fail closed', () => {
  const f = fixture();
  assert.doesNotThrow(() => validateHumanConfig(f.config));
  for (const override of [
    { transport: 'https' },
    { approvalMode: 'passkey' },
    { authMode: 'typo' },
  ])
    assert.throws(() => validateHumanConfig({ ...f.config, ...override }));
  for (const n of [
    { ...f.peer, nodeID: 'host' },
    { ...f.peer, nodeID: 'broker' },
    { ...f.peer, authorizationID: 'stale' },
    { ...f.peer, policy: '0'.repeat(64) },
  ])
    assert.throws(() => f.sessions.issue(n));
  assert.ok(f.sessions.issue({ ...f.peer, nodeID: 'new-member' }));
  const p = f.policy();
  for (const change of [
    { hostNodeID: 'broker' },
    { capability: 'unknown' },
    { controlURL: 'https://attacker.test' },
    { tailnetID: '' },
    { version: 2 },
    {
      allowed: [
        { nodeID: 'phone', ownerID: '42' },
        { nodeID: 'phone', ownerID: '42' },
      ],
    },
    { allowed: [] },
  ])
    assert.throws(() => parseNodePolicy(JSON.stringify({ ...p, ...change })));
});
test('canonical identity headers reject missing, duplicate and malformed proofs', () => {
  const f = fixture();
  const value = Buffer.from(JSON.stringify(f.peer)).toString('base64url');
  assert.deepEqual(verifiedPeer({ rawHeaders: [PEER_HEADER, value] }), f.peer);
  for (const rawHeaders of [
    [],
    [PEER_HEADER, value, PEER_HEADER, value],
    [PEER_HEADER, 'invalid'],
    [PEER_HEADER, Buffer.from(JSON.stringify({ ...f.peer, ip: 'host' })).toString('base64url')],
  ])
    assert.throws(() => verifiedPeer({ rawHeaders }));
});
test('sessions bind node/owner/policy, support separate browser jars, and reject legacy pairing and keys', () => {
  const f = fixture();
  const a = f.issue();
  const b = f.issue();
  assert.notEqual(a.cookie, b.cookie);
  assert.ok(f.sessions.authenticate(a.cookie, f.peer));
  for (const peer of [
    undefined,
    f.laptop,
    { ...f.peer, ownerID: '43' },
    { ...f.peer, policy: '0'.repeat(64) },
  ])
    assert.equal(f.sessions.authenticate(a.cookie, peer), null);
  assert.equal(f.sessions.authorize(a.cookie, 'wrong', f.peer), null);
  assert.throws(() => f.sessions.pair('secret'));
  assert.throws(() => f.sessions.issueDeviceSession('key'));
  f.advance(86400_000);
  assert.equal(f.sessions.authenticate(a.cookie, f.peer), null);
});
test('automatic protected bootstrap never approves and legacy endpoints cannot bypass node mode', async () => {
  const f = fixture();
  const r = await pending(f);
  await serve(f, async (api, boot) => {
    const first = await boot();
    assert.equal(first.status, 200);
    assert.equal(first.data().authMode, 'tailnet-peer');
    assert.ok(first.cookie);
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'])
      assert.ok(first.headers['set-cookie'][0].includes(flag));
    const again = await api('/human/session', { cookie: first.cookie });
    assert.equal(again.headers['set-cookie'], undefined);
    assert.equal(f.calls.length, 0);
    assert.equal(f.broker.view(r.id).state, 'pending');
    const body = { id: r.id, fingerprint: r.fingerprint, decision: 'approve' };
    for (const options of [
      { cookie: first.cookie },
      { cookie: first.cookie, csrf: 'wrong' },
      { cookie: first.cookie, csrf: first.data().csrf, peer: f.laptop },
      {
        cookie: first.cookie,
        csrf: first.data().csrf,
        headers: { origin: 'https://app.example.ts.net' },
      },
    ])
      assert.ok([401, 403].includes((await api('/human/decision', { body, ...options })).status));
    for (const path of [
      '/human/pair',
      '/device/session',
      '/device/challenge',
      '/human/device/register',
    ])
      assert.equal(
        (await api(path, { body: {}, cookie: first.cookie, csrf: first.data().csrf })).status,
        403,
      );
    for (const path of [
      '/registration/options',
      '/registration/verify',
      `/requests/${r.id}/options`,
      `/requests/${r.id}/decision`,
    ])
      assert.equal((await api(path, { peer: null, body: {} })).status, 400);
    const result = await api('/human/decision', {
      body,
      cookie: first.cookie,
      csrf: first.data().csrf,
    });
    assert.equal(result.data().state, 'complete');
    assert.equal(f.calls.length, 1);
    assert.equal(
      (await api('/human/decision', { body, cookie: first.cookie, csrf: first.data().csrf }))
        .status,
      400,
    );
    assert.equal(f.calls.length, 1);
    const page = await api('/review');
    assert.match(page.raw, /data-auth-mode="tailnet-peer"/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
  });
});
test('Node rejects forged peer headers on TCP and unknown peers; machine queue/status stay separate', async () => {
  const f = fixture();
  await serve(
    f,
    async (api) => {
      assert.equal((await api('/human/session')).status, 400);
    },
    true,
  );
  await serve(f, async (api) => {
    for (const peer of [
      null,
      { ...f.peer, nodeID: 'host' },
      { ...f.peer, nodeID: 'broker' },
      { ...f.peer, authorizationID: 'stale' },
    ])
      assert.ok([400, 403].includes((await api('/human/session', { peer })).status));
    const created = await api('/requests', {
      peer: null,
      body: { action: 'slack.channels', payload: {} },
    });
    assert.equal(created.status, 202);
    assert.equal(created.data().state, 'pending');
    assert.equal((await api(`/requests/${created.data().id}`, { peer: null })).status, 200);
  });
});
test('browser logout persists across reload/restart and explicit resume consumes a browser+peer-bound challenge', async () => {
  const f = fixture();
  await serve(f, async (api, boot) => {
    const first = await boot();
    assert.equal(
      (await api('/human/logout', { body: {}, cookie: first.cookie, csrf: first.data().csrf }))
        .status,
      200,
    );
    let paused = await api('/human/session', { cookie: first.cookie });
    assert.equal(paused.status, 401);
    assert.equal(paused.data().resumeRequired, true);
    const restarted = new NodeSessions({
      config: f.config,
      state: structuredClone(f.state),
      save: () => {},
      policy: f.policy,
    });
    assert.ok(restarted.browserPause(first.cookie, f.peer));
    assert.equal(restarted.peerAllowed(f.peer), true);
    const challenge = (
      await api('/human/node/challenge', { body: {}, cookie: first.cookie })
    ).data().challenge;
    assert.equal(
      (
        await api('/human/node/resume', {
          body: { challenge },
          cookie: first.cookie,
          peer: f.laptop,
        })
      ).status,
      400,
    );
    paused = await api('/human/node/challenge', { body: {}, cookie: first.cookie });
    assert.equal(
      (
        await api('/human/node/resume', {
          body: { challenge: paused.data().challenge },
          cookie: first.cookie,
          headers: { origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    const resumed = await api('/human/node/resume', {
      body: { challenge: paused.data().challenge },
      cookie: first.cookie,
    });
    assert.equal(resumed.status, 200);
    assert.ok(resumed.cookie);
    assert.equal(
      (
        await api('/human/node/resume', {
          body: { challenge: paused.data().challenge },
          cookie: first.cookie,
        })
      ).status,
      400,
    );
    assert.equal((await api('/human/pending', { cookie: resumed.cookie })).status, 200);
  });
});
test('device revocation blocks all browser jars, bootstrap, resume and delegated grants across restart', async () => {
  const f = fixture();
  const a = f.issue();
  const b = f.issue();
  const r = await pending(f);
  await approve(f, r, a.session);
  assert.equal(f.broker.listGrants().length, 1);
  f.sessions.endNode(f.peer, true);
  assert.equal(f.sessions.authenticate(b.cookie, f.peer), null);
  assert.throws(() => f.sessions.issue(f.peer));
  assert.throws(() => f.sessions.resumeChallenge(f.peer));
  assert.equal((await pending(f)).state, 'pending');
  assert.equal(f.broker.listGrants().length, 0);
  const restarted = new NodeSessions({
    config: f.config,
    state: structuredClone(f.state),
    save: () => {},
    policy: f.policy,
  });
  assert.equal(restarted.peerAllowed(f.peer, { paused: true }), false);
});
test('policy change or outage invalidates sessions and delegated grants; machine source need not match owner node', async () => {
  for (const boundary of ['removed', 'policy-error', 'rpc-error', 'expired']) {
    const f = fixture();
    const { session } = f.issue();
    await approve(f, await pending(f), session);
    const auto = await pending(f);
    assert.equal(auto.state, 'complete');
    assert.equal(f.calls.length, 2);
    if (boundary === 'removed')
      f.setPolicy(
        parseNodePolicy(
          JSON.stringify({
            ...f.policy(),
            revision: 'changed',
          }),
        ),
      );
    if (boundary === 'policy-error') f.setPolicy(Error('unavailable'));
    if (boundary === 'rpc-error')
      f.sessions.check = async () => {
        throw Error('identity outage');
      };
    if (boundary === 'expired') f.advance(600_000);
    const result = await pending(f);
    assert.ok(['pending', 'failed'].includes(result.state));
    assert.equal(f.calls.length, 2);
    assert.equal(f.broker.listGrants().length, 0);
  }
});
test('revocation during audit, owner check or Slack await prevents dispatch or late grant activation', async () => {
  for (const boundary of ['audit', 'owner-check', 'slack']) {
    const f = fixture();
    const { session } = f.issue();
    const r = await pending(f);
    if (boundary === 'audit') f.broker.save = () => f.sessions.endNode(f.peer, true);
    if (boundary === 'owner-check')
      f.sessions.check = async () => {
        f.sessions.endNode(f.peer, true);
        return true;
      };
    if (boundary === 'slack')
      f.broker.slack = async () => {
        f.calls.push('sent');
        f.sessions.endNode(f.peer, true);
        return {};
      };
    const result = await approve(f, r, session);
    assert.equal(f.broker.listGrants().length, 0);
    assert.equal(f.calls.length, boundary === 'slack' ? 1 : 0);
    assert.equal(result.state, boundary === 'slack' ? 'complete' : 'failed');
    if (boundary === 'slack') assert.ok(result.grantWarning);
  }
});
test('automatic dispatch rechecks owner after audit and async identity query without retrying uncertain writes', async () => {
  const f = fixture();
  const { session } = f.issue();
  await approve(f, await pending(f), session);
  f.sessions.check = async () => {
    f.sessions.endNode(f.peer, true);
    return true;
  };
  const r = await pending(f);
  assert.equal(r.state, 'failed');
  assert.equal(f.calls.length, 1);
  assert.equal((await pending(f)).state, 'pending');
  assert.equal(f.calls.length, 1);
});
test('failed persistence cannot publish a new node-bound session or silently resume a paused node', () => {
  const f = fixture();
  f.sessions.save = () => {
    throw Error('disk full');
  };
  assert.throws(() => f.issue());
  assert.equal(f.state.humanSessions, undefined);
});

test('legacy paired session state remains stored but confers no authority in explicit peer mode', () => {
  const f = fixture();
  const legacy = { tokenHash: 'legacy', csrf: 'unused', expires: 99999999 };
  f.state.humanSessions = [legacy];
  f.state.humanPaired = true;
  f.state.humanDevices = [{ id: 'old-key' }];
  f.issue();
  assert.ok(f.state.humanSessions.includes(legacy));
  assert.equal(f.sessions.isLive(legacy), false);
  assert.deepEqual(f.state.humanDevices, [{ id: 'old-key' }]);
});
test('session and timed-grant expiry observed during owner RPC cannot dispatch or renew permission', async () => {
  for (const boundary of ['session', 'grant']) {
    const f = fixture();
    const { session } = f.issue();
    if (boundary === 'grant') await approve(f, await pending(f), session);
    else session.expires = 1010;
    f.sessions.check = async () => {
      f.advance(boundary === 'session' ? 11 : 600_000);
      return true;
    };
    const r = await pending(f);
    const result = boundary === 'session' ? await approve(f, r, session) : r;
    assert.equal(result.state, 'failed');
    assert.equal(f.calls.length, boundary === 'grant' ? 1 : 0);
    assert.equal(f.broker.listGrants().length, 0);
  }
});
test('node revoke and logout survive an unrelated protected policy revision', () => {
  for (const revoke of [true, false]) {
    const f = fixture();
    f.issue();
    f.sessions.endNode(f.peer, revoke);
    f.setPolicy(parseNodePolicy(JSON.stringify({ ...f.policy(), revision: 'epoch2' })));
    const peer = { ...f.peer, policy: f.policy().digest, authorizationID: 'epoch2' };
    assert.equal(f.sessions.peerAllowed(peer), false);
    assert.equal(f.sessions.peerAllowed(peer, { paused: true }), !revoke);
  }
});

test('automatic dispatch consumes before awaiting authority so manual approve/reject cannot dispatch twice', async () => {
  const f = fixture();
  const { session } = f.issue();
  await approve(f, await pending(f), session);
  let release;
  f.sessions.check = () =>
    new Promise((r) => {
      release = r;
    });
  const automatic = pending(f);
  const r = [...f.broker.requests.values()].at(-1);
  assert.equal(r.state, 'verifying');
  assert.equal(f.broker.pending().length, 0);
  for (const decision of ['approve', 'reject'])
    await assert.rejects(
      f.broker.decideSession(r.id, f.broker.fingerprint(r), decision, { session }),
    );
  assert.equal(f.calls.length, 1);
  release(true);
  assert.equal((await automatic).state, 'complete');
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.broker.execute(r));
  assert.equal(f.calls.length, 2);
});
test('failed logout or device-revoke persistence immediately disables sessions, grants and bootstrap', async () => {
  for (const revoke of [true, false]) {
    const f = fixture();
    const { session, cookie } = f.issue();
    await approve(f, await pending(f), session);
    f.sessions.save = () => {
      throw Error('disk full');
    };
    assert.throws(() => f.sessions.endNode(f.peer, revoke), /storage uncertain/);
    assert.equal(f.sessions.authenticate(cookie, f.peer), null);
    assert.equal(f.sessions.storageFault, true);
    assert.throws(() => f.issue());
    assert.throws(() => f.issue(f.laptop));
    assert.equal(f.broker.listGrants().length, 0);
    assert.equal((await pending(f)).state, 'pending');
    assert.equal(f.calls.length, 1);
  }
});
test('failed revocation persistence while initial Slack action is in flight prevents late grant activation', async () => {
  const f = fixture();
  const { session } = f.issue();
  const r = await pending(f);
  let started;
  const begin = new Promise((r) => {
    started = r;
  });
  let finish;
  f.broker.slack = () => {
    started();
    return new Promise((r) => {
      finish = r;
    });
  };
  const result = approve(f, r, session);
  await begin;
  f.sessions.save = () => {
    throw Error('disk full');
  };
  assert.throws(() => f.sessions.endNode(f.peer, true), /storage uncertain/);
  finish({});
  const done = await result;
  assert.equal(done.state, 'complete');
  assert.ok(done.grantWarning);
  assert.equal(f.broker.listGrants().length, 0);
});
test('observed policy outage permanently invalidates old bearer, and retired generation cannot restore authority after rollback/restart', async () => {
  const f = fixture();
  const { cookie, session } = f.issue();
  const original = f.policy();
  await approve(f, await pending(f), session);
  f.setPolicy(Error('missing policy'));
  assert.equal(f.sessions.authenticate(cookie, f.peer), null);
  f.setPolicy(original);
  assert.equal(f.sessions.authenticate(cookie, f.peer), null);
  assert.equal(f.broker.listGrants().length, 0);
  const fresh = f.issue();
  assert.ok(f.sessions.authenticate(fresh.cookie, f.peer));
  const changed = parseNodePolicy(JSON.stringify({ ...original, revision: 'epoch2' }));
  f.setPolicy(changed);
  const peer2 = { ...f.peer, policy: changed.digest, authorizationID: 'epoch2' };
  assert.equal(f.sessions.peerAllowed(peer2), true);
  assert.equal(f.sessions.isLive(fresh.session), false);
  f.setPolicy(original);
  assert.equal(f.sessions.peerAllowed(f.peer), false);
  assert.throws(() => f.issue());
  const restarted = new NodeSessions({
    config: f.config,
    state: structuredClone(f.state),
    save: () => {},
    policy: () => original,
  });
  assert.equal(restarted.peerAllowed(f.peer), false);
});
test('transport generation change retires old cookie even if protected policy bytes recovered unchanged', () => {
  const f = fixture();
  const a = f.issue();
  const recovered = { ...f.peer, generation: 'generation2' };
  assert.equal(f.sessions.authenticate(a.cookie, recovered), null);
  assert.equal(f.sessions.authenticate(a.cookie, f.peer), null);
  assert.ok(f.issue(recovered));
});
test('resume challenge uses elapsed expiry and pause epoch, and failed resume cannot publish unpause', () => {
  const f = fixture();
  f.issue();
  f.sessions.endNode(f.peer);
  let challenge = f.sessions.resumeChallenge(f.peer);
  f.advanceElapsed(60_000);
  assert.throws(() => f.sessions.resume(f.peer, challenge), /expired/);
  challenge = f.sessions.resumeChallenge(f.peer);
  const old = f.sessions.challenges.get(challenge);
  // Simulate a delayed old challenge crossing a later pause epoch.
  f.state.nodePauseEpochs[JSON.stringify([f.peer.nodeID, f.peer.ownerID])]++;
  f.sessions.challenges.set(challenge, old);
  assert.throws(() => f.sessions.resume(f.peer, challenge), /expired/);
  challenge = f.sessions.resumeChallenge(f.peer);
  f.sessions.save = () => {
    throw Error('disk full');
  };
  assert.throws(() => f.sessions.resume(f.peer, challenge), /storage uncertain/);
  assert.ok(f.state.nodePauses.length);
  assert.equal(f.sessions.peerAllowed(f.peer), false);
});
test('cross-origin/credentialless GET allocates neither sessions nor resume challenges; bootstrap requires protected JSON POST', async () => {
  const f = fixture();
  await serve(f, async (api) => {
    for (let i = 0; i < 4; i++) {
      const get = await api('/human/session', { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(get.status, 401);
      assert.equal(get.data().bootstrap, true);
      assert.equal(get.cookie, undefined);
    }
    assert.equal(f.state.humanSessions, undefined);
    assert.equal(f.sessions.challenges.size, 0);
    for (const path of ['/human/node/session', '/human/node/challenge']) {
      assert.equal((await api(path)).status, 403);
      for (const headers of [
        { origin: '' },
        { origin: 'https://evil.test' },
        { 'sec-fetch-site': 'cross-site' },
      ])
        assert.equal((await api(path, { body: {}, headers })).status, 403);
    }
    assert.equal(f.state.humanSessions, undefined);
    assert.equal(f.sessions.challenges.size, 0);
  });
});
test('policy and assertion schemas reject duplicate keys, case aliases, trailing/nested/oversized input', () => {
  const f = fixture();
  const raw = JSON.stringify(f.policy());
  for (const bad of [
    raw.replace('"version":1', '"Version":1'),
    raw.replace('"version":1', '"version":1,"version":1'),
    raw.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    raw.replace('"version":1', '"version":1e0'),
    raw.replace('"revision":"epoch1"', '"revision":{}'),
    raw + '{}',
    ' '.repeat(16385) + raw,
  ])
    assert.throws(() => parseNodePolicy(bad));
  const proof = JSON.stringify(f.peer).replace('"ownerID":"42"', '"ownerID":"42","ownerID":"42"');
  assert.throws(() =>
    verifiedPeer({ rawHeaders: [PEER_HEADER, Buffer.from(proof).toString('base64url')] }),
  );
});

test('explicit peer timed grant delegates across agents/actions without consuming existing queued requests', async () => {
  const f = fixture();
  const { session } = f.issue();
  const queued = await pending(f);
  const listing = await f.broker.create({ action: 'slack.channels', payload: {} });
  assert.equal((await approve(f, listing, session)).state, 'complete');
  assert.equal(f.broker.view(queued.id).state, 'pending');
  assert.equal(f.calls.length, 1);
  const delegated = await f.broker.create({
    action: 'slack.unpost',
    payload: { ref: 'C999', ts: '2.3' },
  });
  assert.equal(delegated.state, 'complete');
  assert.equal(f.calls.length, 2);
  assert.equal(f.broker.view(queued.id).state, 'pending');
});
test('peer session issuance is bounded and polling preserves independent browser bearers without writes', () => {
  const f = fixture();
  let writes = 0;
  f.sessions.save = () => {
    writes++;
  };
  const first = f.issue();
  const second = f.issue();
  for (let i = 2; i < 128; i++) f.issue();
  const issuedWrites = writes;
  for (let i = 0; i < 10; i++) {
    assert.ok(f.sessions.authenticate(first.cookie, f.peer));
    assert.ok(f.sessions.authenticate(second.cookie, f.peer));
  }
  assert.equal(writes, issuedWrites);
  assert.equal(f.state.humanSessions.length, 128);
  assert.throws(() => f.issue(), /Too many/);
  assert.equal(writes, issuedWrites);
  assert.ok(f.sessions.authenticate(first.cookie, f.peer));
});

test('browser logout preserves sibling jar sessions/grants and only explicit cookie-bound Resume restores its access', async () => {
  const f = fixture();
  const a = f.issue();
  const b = f.issue();
  const requestA = await pending(f);
  const requestB = await pending(f);
  const ar = await approve(f, requestA, a.session);
  const br = await approve(f, requestB, b.session);
  assert.ok(ar.grantID);
  assert.ok(br.grantID);
  const marker = f.sessions.endBrowser(a.cookie, a.session.csrf, f.peer);
  assert.equal(marker.token, a.cookie.split('=')[1]);
  assert.equal(f.sessions.authenticate(a.cookie, f.peer), null);
  assert.ok(f.sessions.authenticate(b.cookie, f.peer));
  assert.deepEqual(
    f.broker.listGrants().map((g) => g.id),
    [br.grantID],
  );
  assert.throws(() => f.sessions.issue(f.peer, { cookie: a.cookie }), /signed out/);
  const c = f.sessions.resumeChallenge(f.peer, a.cookie);
  assert.throws(() => f.sessions.resume(f.peer, c, b.cookie), /expired/);
  const next = f.sessions.resumeChallenge(f.peer, a.cookie);
  const resumed = f.sessions.resume(f.peer, next, a.cookie);
  assert.ok(resumed.token);
  assert.equal(f.sessions.browserPause(a.cookie, f.peer), null);
  assert.ok(f.sessions.authenticate(b.cookie, f.peer));
});
test('browser logout durable marker suppresses automatic bootstrap after restart without affecting a different jar', async () => {
  const f = fixture();
  const a = f.issue();
  f.sessions.endBrowser(a.cookie, a.session.csrf, f.peer);
  const restarted = new NodeSessions({
    config: f.config,
    state: structuredClone(f.state),
    save: () => {},
    policy: f.policy,
  });
  assert.ok(restarted.browserPause(a.cookie, f.peer));
  assert.throws(() => restarted.issue(f.peer, { cookie: a.cookie }), /signed out/);
  assert.ok(restarted.issue(f.peer));
});
test('failed browser logout persistence denies authority and cannot activate an in-flight grant', async () => {
  const f = fixture();
  const a = f.issue();
  const r = await pending(f);
  let started;
  const begin = new Promise((r) => {
    started = r;
  });
  let finish;
  f.broker.slack = () => {
    started();
    return new Promise((r) => {
      finish = r;
    });
  };
  const granting = approve(f, r, a.session);
  await begin;
  f.sessions.save = () => {
    throw Error('disk full');
  };
  assert.throws(() => f.sessions.endBrowser(a.cookie, a.session.csrf, f.peer), /storage uncertain/);
  assert.ok(f.sessions.browserPause(a.cookie, f.peer));
  assert.equal(f.sessions.authenticate(a.cookie, f.peer), null);
  finish({});
  const result = await granting;
  assert.ok(result.grantWarning);
  assert.equal(f.broker.listGrants().length, 0);
});

test('explicit paired mode cannot reinterpret a node-bound bearer as legacy authority', () => {
  const f = fixture();
  const a = f.issue();
  const paired = new HumanSessions({
    config: { ...f.config, authMode: 'paired' },
    state: f.state,
    save: () => {},
    now: () => 1000,
  });
  assert.equal(paired.authenticate(a.cookie), null);
  assert.ok(f.sessions.authenticate(a.cookie, f.peer));
});
