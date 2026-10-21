import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { sameOriginGuard } from '../same-origin.js';
import { slackBrokerRequest } from '../slack-broker.js';
import { slackPasskeyRoutes } from './slack-passkey.js';
vi.mock('../slack-broker.js', () => ({ slackBrokerRequest: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
function setup() {
  const track = vi.fn();
  const app = new Hono();
  app.use('*', sameOriginGuard({ log: () => {} }));
  app.route(
    '/passkey',
    slackPasskeyRoutes({
      paneExists: (id) => ['a', 'b'].includes(id),
      owned: (p) => (p === 'a' ? ids : []),
      track,
    }),
  );
  vi.mocked(slackBrokerRequest).mockImplementation(async (path) =>
    path === '/inline/status'
      ? { mode: 'passkey-inline', registered: true }
      : {
          id: path.split('/').at(-1),
          state: 'pending',
          payload: { text: 'exact' },
          fingerprint: 'immutable',
        },
  );
  return { app, track };
}
it('routes only authenticated-proof operations, never admin/arbitrary broker paths', async () => {
  const { app } = setup();
  for (const operation of ['confirm-enrollment', 'revoke-credential', 'state', 'human', 'execute'])
    expect(
      (
        await app.request(`/passkey/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: {} }),
        })
      ).status,
    ).toBe(404);
  expect(slackBrokerRequest).not.toHaveBeenCalled();
});
it('forwards assertion body exactly once and tracks result without caller ownership transfer', async () => {
  const { app, track } = setup();
  const body = { ceremonyID: 'nonce', response: { id: 'public-signature' } };
  const r = await app.request('/passkey/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  expect(r.status).toBe(200);
  expect(slackBrokerRequest).toHaveBeenCalledTimes(1);
  expect(slackBrokerRequest).toHaveBeenCalledWith('/inline/decision', body, 125000);
  expect(track).toHaveBeenCalledTimes(1);
});
it('pending response contains only exact originating pane request IDs; other pane receives none', async () => {
  const { app } = setup();
  const a = await (await app.request('/passkey/pending?pane=a')).json();
  expect(a.requests.map((r: { id: string }) => r.id)).toEqual(ids);
  vi.mocked(slackBrokerRequest).mockClear();
  const b = await (await app.request('/passkey/pending?pane=b')).json();
  expect(b.requests).toEqual([]);
  expect(slackBrokerRequest).toHaveBeenCalledTimes(1);
  expect(slackBrokerRequest).toHaveBeenCalledWith('/inline/status', undefined, 3000);
  expect((await app.request('/passkey/pending?pane=unknown')).status).toBe(404);
});
it('foreign-origin POST denied before relay, size/type/schema bounded and no CORS', async () => {
  const { app } = setup();
  const r = await app.request('http://muxpad.test/passkey/options', {
    method: 'POST',
    headers: {
      Host: 'muxpad.test',
      Origin: 'https://evil.test',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  expect(r.status).toBe(403);
  expect(r.headers.get('access-control-allow-origin')).toBeNull();
  expect(slackBrokerRequest).not.toHaveBeenCalled();
  expect(
    (
      await app.request('/passkey/options', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await app.request('/passkey/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ' '.repeat(65537),
      })
    ).status,
  ).toBe(413);
});
it('legacy is recognized only by explicit missing endpoint; outages never downgrade mode', async () => {
  const { app } = setup();
  vi.mocked(slackBrokerRequest).mockRejectedValueOnce(Object.assign(Error(), { status: 404 }));
  expect(await (await app.request('/passkey/status')).json()).toEqual({ mode: 'legacy' });
  vi.mocked(slackBrokerRequest).mockRejectedValueOnce(Object.assign(Error(), { status: 503 }));
  const r = await app.request('/passkey/status');
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ mode: 'unavailable' });
});
it('relay uncertainty makes only one attempt and does not mutate tracking', async () => {
  const { app, track } = setup();
  vi.mocked(slackBrokerRequest).mockRejectedValue(Error('PRIVATE token details'));
  const r = await app.request('/passkey/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: { ceremonyID: 'nonce', response: {} } }),
  });
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain('PRIVATE');
  expect(slackBrokerRequest).toHaveBeenCalledTimes(1);
  expect(track).not.toHaveBeenCalled();
});
