import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { sameOriginGuard } from '../same-origin.js';
import { slackBrokerRequest } from '../slack-broker.js';
import { slackSetupRoutes } from './slack-setup.js';
vi.mock('../slack-broker.js', () => ({
  slackBrokerRequest: vi.fn(),
  slackBrokerURL: vi.fn(() => 'https://broker.test'),
}));
afterEach(() => vi.resetAllMocks());
const op = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
function app() {
  const a = new Hono();
  a.use('*', sameOriginGuard({ log: () => {} }));
  a.route('/setup', slackSetupRoutes());
  return a;
}
const post = (a: ReturnType<typeof app>, body: unknown, origin?: string) =>
  a.request('/setup/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
function mock(state = 'pending') {
  vi.mocked(slackBrokerRequest).mockImplementation(async (p) =>
    p === '/health'
      ? { version: 'v' }
      : p === '/inline/status'
        ? { mode: 'passkey-inline', registered: true }
        : {
            id,
            action: 'slack.channels',
            state,
            expires: Date.now() + 300000,
            payload: {},
            result: { channels: [{ name: 'PRIVATE-NAME' }] },
          },
  );
}
it('explicit read-only test submits channels exactly once; same operation recovers a lost response', async () => {
  mock();
  const a = app();
  const r = await post(a, { operationID: op });
  expect(r.status).toBe(202);
  expect(await r.json()).toMatchObject({ requestID: id });
  await post(a, { operationID: op });
  expect(vi.mocked(slackBrokerRequest).mock.calls.filter(([p]) => p === '/requests')).toEqual([
    ['/requests', { action: 'slack.channels', payload: {} }],
  ]);
});
it('does not accept caller actions/payloads and refuses cross-origin creation', async () => {
  mock();
  const a = app();
  expect((await post(a, { operationID: op, action: 'slack.post' })).status).not.toBe(202);
  expect((await post(a, { operationID: op }, 'https://evil.test')).status).toBe(403);
  expect(vi.mocked(slackBrokerRequest).mock.calls.filter(([p]) => p === '/requests')).toHaveLength(
    0,
  );
});
it('test result proves complete only from matching broker ID/action and never returns names', async () => {
  mock('complete');
  const a = app();
  await post(a, { operationID: op });
  const r = await (await a.request(`/setup/test/${op}`)).json();
  expect(r).toMatchObject({ state: 'complete', channelCount: 1, versionChanged: false });
  expect(JSON.stringify(r)).not.toContain('PRIVATE-NAME');
  expect((await a.request('/setup/test/unknown')).status).toBe(404);
});
it('pending diagnostic is confined to its request and synthetic scope, never borrowed from another chat', async () => {
  mock();
  const a = app();
  await post(a, { operationID: op });
  const r = await (await a.request(`/setup/test/${op}/pending`)).json();
  expect(r.pane).toBe(`setup-${op}`);
  expect(r.requests).toHaveLength(1);
  const none = await (await a.request('/setup/test/unknown/pending')).json();
  expect(none.requests).toHaveLength(0);
});
it('rate bound prevents duplicate concurrent diagnostics before broker creation completes', async () => {
  mock();
  const a = app();
  await post(a, { operationID: op });
  expect((await post(a, { operationID: '33333333-3333-4333-8333-333333333333' })).status).toBe(429);
});
it('mismatched broker result cannot mark the live test complete', async () => {
  mock();
  const a = app();
  await post(a, { operationID: op });
  vi.mocked(slackBrokerRequest).mockResolvedValue({
    id: 'other',
    state: 'complete',
    action: 'slack.post',
  });
  expect((await a.request(`/setup/test/${op}`)).status).toBe(502);
});
it('uncertain broker creation reserves the operation before dispatch and never redispatches that ID', async () => {
  vi.mocked(slackBrokerRequest).mockImplementation(async (p) => {
    if (p === '/health') return { version: 'v' };
    throw Error('Response lost after possible creation');
  });
  const a = app();
  const first = await (await post(a, { operationID: op })).json();
  expect(first).toMatchObject({ testID: op, requestID: null, state: 'uncertain' });
  await post(a, { operationID: op });
  expect(vi.mocked(slackBrokerRequest).mock.calls.filter(([p]) => p === '/requests')).toHaveLength(
    1,
  );
  const r = await (await a.request(`/setup/test/${op}`)).json();
  expect(r.state).toBe('uncertain');
  expect((await (await a.request(`/setup/test/${op}/pending`)).json()).requests).toEqual([]);
});
