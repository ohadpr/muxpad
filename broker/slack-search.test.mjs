import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { safeSlackErrorCode, slackClient } from './slack.mjs';
const previous = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previous;
});
const token = 'secret-token-NEVER-IN-URL';
test('search sends one canonical GET with literal escaped Unicode/&/+, decimalinteger and configuredteam only', async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(
      url,
      'https://slack.com/api/search.messages?query=Alona+%26+%2B+%D7%90%D7%9C%D7%95%D7%A0%D7%94&count=30&team_id=T123',
    );
    assert.equal(url.includes(token), false);
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { authorization: 'Bearer ' + token });
    assert.equal(Object.hasOwn(options, 'body'), false);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messages: { matches: [{ ts: '1', user: 'U1', text: 'match', channel: { name: 'test' } }] },
      }),
    };
  };
  assert.deepEqual(
    await slackClient(token, 'T123').run('slack.search', {
      query: 'Alona & + אלונה',
      limit: 30,
      team_id: 'FORGED',
    }),
    { messages: [{ ts: '1', who: 'U1', text: 'match', channel: 'test' }] },
  );
  assert.equal(calls, 1);
});
test('invalid count is rejected beforefetch, never fallback/coercion or retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error('not reached');
  };
  for (const limit of [0, 1.2, 101, Number.NaN, Number.POSITIVE_INFINITY, '30', undefined])
    await assert.rejects(
      slackClient(token, 'T1').run('slack.search', { query: 'Alona', limit }),
      (e) => safeSlackErrorCode(e) === 'invalid_arguments',
    );
  assert.equal(calls, 0);
});
test('search rejection returns existing safe code with exactly one GET and no POST fallback', async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'invalid_arguments', needed: token }),
    };
  };
  await assert.rejects(
    slackClient(token, 'T1').run('slack.search', { query: 'Alona', limit: 30 }),
    (e) => safeSlackErrorCode(e) === 'invalid_arguments' && !e.message.includes(token),
  );
  assert.equal(calls, 1);
});
test('post/delete remain original JSON POSTs and mapping', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, channel: 'C1', ts: '1' }) };
  };
  const c = slackClient(token, 'T1');
  await c.run('slack.post', { channel: 'C1', text: 'hello' });
  await c.run('slack.unpost', { channel: 'C1', ts: '1' });
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://slack.com/api/chat.postMessage', 'https://slack.com/api/chat.delete'],
  );
  for (const c of calls) {
    assert.equal(c.options.method, 'POST');
    assert.equal(c.options.headers['content-type'], 'application/json');
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    channel: 'C1',
    text: 'hello',
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), { channel: 'C1', ts: '1' });
});
