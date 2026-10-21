import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { Broker } from './core.mjs';
import { safeSlackErrorCode, slackClient } from './slack.mjs';
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));
function mock(results) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const value = results.shift();
    if (value instanceof Error) throw value;
    return { ok: true, status: 200, json: async () => value };
  };
  return calls;
}
function broker(config = {}) {
  return new Broker({
    config: { teamID: 'T123', ...config },
    state: { credential: { id: 'test' } },
    save: () => {},
    slack: async () => ({}),
  });
}
test('username lookup paginates exact names and does not expose profile emails', async () => {
  const calls = mock([
    {
      ok: true,
      members: [{ id: 'UOTHER', name: 'alona-other' }],
      response_metadata: { next_cursor: 'next+&' },
    },
    {
      ok: true,
      members: [
        { id: 'U123', name: 'alona', profile: { email: 'private', display_name: 'Alona' } },
      ],
    },
  ]);
  assert.deepEqual(await slackClient('secret', 'T123').run('slack.users', { name: 'alona' }), {
    user: { id: 'U123', name: 'alona', display_name: 'Alona' },
  });
  assert.equal(new URL(calls[1].url).searchParams.get('cursor'), 'next+&');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret');
  assert(!calls[0].url.includes('secret'));
});
test('ambiguous, missing and incomplete user listings never choose a person', async () => {
  for (const members of [
    [],
    [
      { id: 'U1', name: 'a' },
      { id: 'U2', name: 'a' },
    ],
  ]) {
    mock([{ ok: true, members }]);
    await assert.rejects(slackClient('s', 'T').run('slack.users', { name: 'a' }));
  }
  const calls = mock(
    Array.from({ length: 5 }, () => ({
      ok: true,
      members: [{ id: 'U1', name: 'a' }],
      response_metadata: { next_cursor: 'more' },
    })),
  );
  await assert.rejects(slackClient('s', 'T').run('slack.users', { name: 'a' }));
  assert.equal(calls.length, 5);
});
test('DM opening accepts only canonical direct conversation results', async () => {
  const calls = mock([{ ok: true, channel: { id: 'D123' } }]);
  assert.deepEqual(await slackClient('s', 'T').run('slack.dm', { user: 'U123' }), {
    channel: 'D123',
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), { users: 'U123' });
  mock([{ ok: true, channel: { id: 'C123' } }]);
  await assert.rejects(slackClient('s', 'T').run('slack.dm', { user: 'U123' }));
});
test('threads and reply send exact parent timestamps; edits and reactions have one dispatch', async () => {
  const calls = mock([
    { ok: true, messages: [{ ts: '1.1', user: 'U1', text: 'parent' }], has_more: true },
    { ok: true, channel: 'C1', ts: '2.1' },
    { ok: true },
    { ok: true },
    { ok: true, channel: 'C1', ts: '2.1' },
  ]);
  const s = slackClient('s', 'T');
  assert.equal(
    (await s.run('slack.thread', { channel: 'C1', ts: '1.1', limit: 10 })).has_more,
    true,
  );
  await s.run('slack.post', { channel: 'C1', text: '🤖 reply', thread_ts: '1.1' });
  await s.run('slack.react', { channel: 'C1', ts: '2.1', name: 'eyes', operation: 'add' });
  await s.run('slack.react', { channel: 'C1', ts: '2.1', name: 'eyes', operation: 'remove' });
  await s.run('slack.edit', { channel: 'C1', ts: '2.1', text: '🤖 corrected' });
  assert.equal(new URL(calls[0].url).searchParams.get('ts'), '1.1');
  assert.equal(JSON.parse(calls[1].options.body).thread_ts, '1.1');
  assert.equal(JSON.parse(calls[2].options.body).timestamp, '2.1');
  assert(calls[3].url.endsWith('reactions.remove'));
  assert(calls[4].url.endsWith('chat.update'));
});
test('upload uses current three-step flow, hash bound bytes, no token on upload host', async () => {
  const bytes = Buffer.from('binary\u0000+&📎'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const calls = mock([
    { ok: true, upload_url: 'https://files.slack.com/upload/v1/signed', file_id: 'F123' },
    {},
    { ok: true },
  ]);
  const result = await slackClient('secret', 'T').run(
    'slack.upload',
    {
      channel: 'C1',
      filename: 'x.txt',
      bytes: bytes.length,
      sha256,
      text: '🤖 file',
      thread_ts: '1.1',
    },
    bytes,
  );
  assert.equal(result.file, 'F123');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.deepEqual(calls[1].options.body, bytes);
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(JSON.parse(calls[2].options.body).thread_ts, '1.1');
  mock([]);
  await assert.rejects(slackClient('s', 'T').run('slack.upload', { bytes: 1, sha256 }, bytes));
});
test('upload URL rejects arbitrary targets and redirects; uncertain upload is not retried/completed', async () => {
  for (const url of [
    'http://files.slack.com/upload/a',
    'https://evil.example/upload/a',
    'https://files.slack.com.evil/upload/a',
    'https://x@files.slack.com/upload/a',
    'https://files.slack.com/api/a',
  ]) {
    const calls = mock([{ ok: true, upload_url: url, file_id: 'F1' }]);
    const b = Buffer.from('a');
    await assert.rejects(
      slackClient('s', 'T').run(
        'slack.upload',
        { filename: 'a', bytes: 1, sha256: createHash('sha256').update(b).digest('hex') },
        b,
      ),
    );
    assert.equal(calls.length, 1);
  }
  const b = Buffer.from('a'),
    calls = mock([
      { ok: true, upload_url: 'https://files.slack.com/upload/a', file_id: 'F1' },
      new Error('secret'),
    ]);
  await assert.rejects(
    slackClient('s', 'T').run(
      'slack.upload',
      { filename: 'a', bytes: 1, sha256: createHash('sha256').update(b).digest('hex') },
      b,
    ),
  );
  assert.equal(calls.length, 2);
});
test('broker snapshots file bytes privately and binds filename/hash/length/destination, expiry frees budget', async () => {
  const b = broker(),
    r = await b.create({
      action: 'slack.upload',
      payload: { ref: 'C1', filename: 'a.txt', content: Buffer.from('hello').toString('base64') },
    });
  assert.equal(r.payload.bytes, 5);
  assert.equal(r.payload.sha256, createHash('sha256').update('hello').digest('hex'));
  assert(!JSON.stringify(r).includes('aGVsbG8='));
  assert.equal(b.uploads.get(r.id).toString(), 'hello');
  b.requests.get(r.id).expires = 0;
  b.prune();
  assert.equal(b.uploads.size, 0);
});
test('invalid upload fields, unsafe channel, invalid threads/reactions, unrecorded edits rejected before dispatch', async () => {
  const b = broker();
  for (const payload of [
    { ref: 'C1', filename: '../a', content: 'YQ==' },
    { ref: 'C1', filename: 'a', content: 'YR==' },
    { ref: 'C1', filename: 'a', content: '' },
  ])
    await assert.rejects(b.create({ action: 'slack.upload', payload }));
  await assert.rejects(
    b.create({ action: 'slack.edit', payload: { ref: 'C1', ts: '1.1', text: 'oops' } }),
    /Only messages/,
  );
  await assert.rejects(
    b.create({ action: 'slack.post', payload: { ref: 'C1', text: 'a', thread_ts: 'bad' } }),
  );
  await assert.rejects(
    b.create({
      action: 'slack.react',
      payload: { ref: 'C1', ts: '1.1', name: 'eyes', operation: 'delete' },
    }),
  );
  await assert.rejects(
    broker({ channels: ['C1'] }).create({ action: 'slack.dm', payload: { user: 'U1' } }),
  );
});
test('recorded muxpad message can be edited; human messages cannot; post registry persists before completion', async () => {
  const b = broker();
  b.slack = async () => ({ channel: 'C1', ts: '1.1' });
  const r = await b.create({ action: 'slack.post', payload: { ref: 'C1', text: 'hello' } });
  await b.execute(b.get(r.id));
  const edit = await b.create({
    action: 'slack.edit',
    payload: { ref: 'C1', ts: '1.1', text: 'updated' },
  });
  assert.equal(edit.payload.text, '🤖 updated');
  await assert.rejects(
    b.create({ action: 'slack.edit', payload: { ref: 'C1', ts: '2.1', text: 'human' } }),
  );
});
test('stale v1 timed decisions cannot grant expanded scope', async () => {
  const b = broker({ approvalMode: 'session' });
  b.state.humanPaired = true;
  const r = await b.create({ action: 'slack.channels' });
  await assert.rejects(
    b.decideSession(r.id, r.fingerprint, 'approve', {
      duration: '10m',
      scope: 'slack-team-all-v1',
    }),
    /Explicit full Slack/,
  );
  assert.equal(b.listGrants().length, 0);
});

test('pending upload budget is bounded and consumed bytes are released on dispatch failure', async () => {
  const b = broker();
  b.uploads.set('other', Buffer.alloc(20 * 1024 * 1024));
  await assert.rejects(
    b.create({ action: 'slack.upload', payload: { ref: 'C1', filename: 'a', content: 'YQ==' } }),
    /limit/,
  );
  b.uploads.clear();
  const r = await b.create({
    action: 'slack.upload',
    payload: { ref: 'C1', filename: 'a', content: 'YQ==' },
  });
  b.slack = async () => {
    throw Error('uncertain write');
  };
  await b.execute(b.get(r.id));
  assert.equal(b.view(r.id).state, 'failed');
  assert.equal(b.uploads.size, 0);
  await assert.rejects(b.execute(b.get(r.id)), /consumed/);
});

test('maximum-size 10 MiB upload validates without regex stack growth and exact bytes survive snapshot', async () => {
  const b = broker(),
    bytes = Buffer.alloc(10 * 1024 * 1024, 0xab);
  const r = await b.create({
    action: 'slack.upload',
    payload: { ref: 'C1', filename: 'max.bin', content: bytes.toString('base64') },
  });
  assert.equal(r.payload.bytes, bytes.length);
  assert.equal(r.payload.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(b.uploads.get(r.id), bytes);
  await assert.rejects(
    b.create({
      action: 'slack.upload',
      payload: {
        ref: 'C1',
        filename: 'too-big.bin',
        content: Buffer.alloc(bytes.length + 1).toString('base64'),
      },
    }),
  );
});
