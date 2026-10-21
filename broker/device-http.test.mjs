import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Broker } from './core.mjs';
import { handler } from './http.mjs';
import { HumanSessions, SESSION_COOKIE } from './human-session.mjs';

test('device HTTP endpoints preserve origin, registration, signature, cookie and revocation boundaries', async () => {
  const state = {};
  const origin = 'https://secure.example.test';
  const config = {
    origin,
    approvalMode: 'session',
    muxpadURL: 'https://app.example.test/',
    teamID: 'T123',
    bootstrapHash: createHash('sha256').update('pair').digest('base64url'),
  };
  let failure = false;
  const save = () => {
    if (failure) throw Error('disk');
  };
  const sessions = new HumanSessions({ config, state, save });
  const cookie = `${SESSION_COOKIE}=${sessions.pair('pair').token}`;
  const csrf = sessions.authenticate(cookie).csrf;
  const broker = new Broker({
    config,
    state,
    save,
    slack: () => {
      throw Error('must not execute Slack');
    },
  });
  const server = createServer(handler(broker, origin, { config, sessions }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = (path, body, headers = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kty, crv, x, y } = k.publicKey.export({ format: 'jwk' });
  const body = { publicKey: { kty, crv, x, y } };
  try {
    const review = await api('/review');
    assert.equal(review.status, 200);
    assert.match(review.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(review.headers.get('x-frame-options'), 'DENY');
    assert.match(await review.text(), /data-review="true"/);
    assert.equal((await api('/human/device/register', body, { Origin: origin })).status, 401);
    assert.equal(
      (await api('/human/device/register', body, { Origin: origin, Cookie: cookie })).status,
      403,
    );
    assert.equal(
      (
        await api('/human/device/register', body, {
          Origin: 'https://attacker.test',
          Cookie: cookie,
          'x-muxpad-csrf': csrf,
        })
      ).status,
      403,
    );
    const registered = await api('/human/device/register', body, {
      Origin: origin,
      Cookie: cookie,
      'x-muxpad-csrf': csrf,
    });
    assert.equal(registered.status, 200);
    const { deviceID } = await registered.json();
    assert.equal((await api('/device/challenge', { deviceID })).status, 403);
    assert.equal(
      (await api('/device/challenge', { deviceID }, { Origin: 'https://attacker.test' })).status,
      403,
    );
    const c = await (await api('/device/challenge', { deviceID }, { Origin: origin })).json();
    const signature = sign('sha256', Buffer.from(c.message), {
      key: k.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const renewal = { deviceID, challengeID: c.challengeID, signature };
    assert.equal((await api('/device/session', renewal)).status, 403);
    const renewed = await api('/device/session', renewal, { Origin: origin });
    assert.equal(renewed.status, 200);
    const header = renewed.headers.get('set-cookie');
    assert.match(header, /^__Host-muxpad-human=/);
    assert.match(header, /Secure; HttpOnly; SameSite=Strict; Path=\//);
    assert.doesNotMatch(header, /Domain=/);
    assert.equal((await api('/device/session', renewal, { Origin: origin })).status, 400);
    const nextCookie = header.split(';')[0];
    assert.equal((await api('/human/session', undefined, { Cookie: cookie })).status, 401);
    const session = await (await api('/human/session', undefined, { Cookie: nextCookie })).json();
    const second = await (await api('/device/challenge', { deviceID }, { Origin: origin })).json();
    failure = true;
    const secondProof = {
      deviceID,
      challengeID: second.challengeID,
      signature: sign('sha256', Buffer.from(second.message), {
        key: k.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
    };
    const refused = await api('/device/session', secondProof, { Origin: origin });
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get('set-cookie'), null);
    failure = false;
    assert.equal((await api('/device/session', secondProof, { Origin: origin })).status, 400);
    const pending = await (await api('/device/challenge', { deviceID }, { Origin: origin })).json();
    assert.equal(
      (
        await api(
          '/human/logout',
          {},
          { Origin: origin, Cookie: nextCookie, 'x-muxpad-csrf': session.csrf },
        )
      ).status,
      200,
    );
    assert.equal(state.deviceEnrollmentComplete, true);
    assert.equal(state.humanDevices.length, 0);
    const revoked = await api(
      '/device/session',
      {
        deviceID,
        challengeID: pending.challengeID,
        signature: sign('sha256', Buffer.from(pending.message), {
          key: k.privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      },
      { Origin: origin },
    );
    assert.equal(revoked.status, 400);
    assert.equal(revoked.headers.get('set-cookie'), null);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
