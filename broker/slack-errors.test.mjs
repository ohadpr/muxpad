import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Broker } from './core.mjs';
import { safeSlackErrorCode, slackClient } from './slack.mjs';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const secret = 'DO-NOT-DISCLOSE-xoxb-private';
const allowed = [
  'missing_scope',
  'invalid_auth',
  'token_revoked',
  'not_authed',
  'ratelimited',
  'channel_not_found',
  'not_in_channel',
  'invalid_arguments',
];
function fixture(response) {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.deepEqual(
      [...new URL(_url).searchParams],
      [
        ['query', 'Alona'],
        ['count', '5'],
        ['team_id', 'T1'],
      ],
    );
    if (response instanceof Error) throw response;
    return response;
  };
  const client = slackClient(secret, 'T1');
  const broker = new Broker({
    config: { teamID: 'T1', channels: [] },
    state: {},
    save: () => {},
    slack: client.run,
  });
  const request = {
    id: 'request',
    teamID: 'T1',
    action: 'slack.search',
    state: 'pending',
    payload: { query: 'Alona', limit: 5 },
  };
  return { broker, request, calls: () => calls };
}
for (const code of allowed)
  test('safe Slack code ' +
    code +
    ' reaches failed execution without body/secrets/retry', async () => {
    const f = fixture({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error: code,
        message: secret,
        needed: secret,
        provided: secret,
        headers: { authorization: secret },
      }),
    });
    await f.broker.execute(f.request);
    assert.equal(f.request.state, 'failed');
    assert.equal(f.request.error, `Slack request failed (${code}); inspect Slack before retrying`);
    assert.equal(JSON.stringify(f.request).includes(secret), false);
    assert.equal(f.calls(), 1);
    await assert.rejects(f.broker.execute(f.request), /consumed/);
    assert.equal(f.calls(), 1);
  });
test('HTTP429 maps to ratelimited without reading body/headers or retrying', async () => {
  let body = 0;
  const f = fixture({
    ok: false,
    status: 429,
    json: async () => {
      body++;
      throw Error(secret);
    },
    get headers() {
      throw Error('headers must not be read ' + secret);
    },
  });
  await f.broker.execute(f.request);
  assert.ok(f.request.error.includes('(ratelimited)'));
  assert.equal(body, 0);
  assert.equal(f.calls(), 1);
});
for (const [label, response] of [
  [
    'unknown code',
    {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'unknown_' + secret, message: secret }),
    },
  ],
  [
    'code suffix injection',
    { ok: true, status: 200, json: async () => ({ ok: false, error: 'missing_scope\n' + secret }) },
  ],
  [
    'malformed JSON',
    {
      ok: false,
      status: 502,
      json: async () => {
        throw Error(secret);
      },
    },
  ],
  ['null result', { ok: true, status: 200, json: async () => null }],
  ['network failure', Error(secret)],
])
  test(label + ' stays generic and never retries', async () => {
    const f = fixture(response);
    await f.broker.execute(f.request);
    assert.equal(f.request.error, 'Slack request failed; inspect Slack before retrying');
    assert.equal(f.calls(), 1);
    assert.equal(JSON.stringify(f.request).includes(secret), false);
  });
test('direct client errors also suppress raw fetch/JSON errors and unrelated forged codes', async () => {
  const f = fixture(Error(secret));
  await assert.rejects(
    slackClient(secret, 'T1').run('slack.search', { query: 'Alona', limit: 5 }),
    (error) => error.message === 'Slack request failed' && !JSON.stringify(error).includes(secret),
  );
  assert.equal(f.calls(), 1);
  assert.equal(
    safeSlackErrorCode(Object.assign(Error(secret), { code: 'missing_scope' })),
    undefined,
  );
});
