import { describe, expect, it, vi } from 'vitest';
import { slackNoticeDiagnosticRoutes } from './slack-notice-diagnostic.js';
const sample = {
  build: 'index-abc.js',
  visibility: 'visible',
  viewportW: 400,
  viewportH: 800,
  shells: 0,
  shellActive: null,
  face: null,
  chats: 0,
  chatActive: null,
  hasSession: null,
  alerts: 0,
  shellRect: null,
  chatRect: null,
  visualViewport: null,
  alertRect: null,
  composerRect: null,
  ancestorHidden: false,
  ancestorDisplayNone: false,
  ancestorVisibilityHidden: false,
  alertInViewport: false,
  alertHitTest: null,
  poll: {
    state: 'absent',
    http: null,
    pending: null,
    stale: null,
    ageMs: null,
  },
  server: { state: 'success', http: 200, pending: 1 },
};
const client = '11111111-1111-4111-8111-111111111111';
function setup() {
  let now = 10000;
  const app = slackNoticeDiagnosticRoutes(
    (id) => id === 'pane-a',
    () => now,
  );
  const get = async (path = '') => app.request(`/${path}`);
  const post = (path: string, body: unknown, origin = 'http://localhost') =>
    app.request(`/${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    app,
    get,
    post,
    tick(n: number) {
      now += n;
    },
    async arm() {
      await post('arm', { pane: 'pane-a' });
      return (await (await get()).json()).nonce as string;
    },
  };
}
describe('temporary notice diagnostics', () => {
  it('defaults disabled, strict targets and no authority/request creation', async () => {
    const t = setup();
    expect(await (await t.get()).json()).toEqual({ enabled: false });
    expect((await t.post('arm', { pane: 'other' })).status).toBe(404);
    expect((await t.post('arm', { pane: 'pane-a', text: 'secret' })).status).toBe(400);
    expect((await t.app.request('/requests', { method: 'POST' })).status).toBe(403);
  });
  it('rejects cross-origin config/results and mutations with no CORS', async () => {
    const t = setup();
    await t.arm();
    for (const path of ['/', '/results']) {
      const r = await t.app.request(path, {
        headers: { Origin: 'https://evil.test' },
      });
      expect(r.status).toBe(403);
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await t.post('disarm', {}, 'https://evil.test')).status).toBe(403);
    expect(
      (
        await t.app.request('/arm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
  it('stores only strict scalar samples, server receipt time, bounded body before parsing', async () => {
    const t = setup();
    const nonce = await t.arm();
    const r = await t.post('report', { nonce, pane: 'pane-a', client, sample });
    expect(r.status).toBe(200);
    const result = await (await t.get('results')).json();
    expect(result.clients[0].reports).toEqual([{ received: 10000, sample }]);
    expect(
      (
        await t.post('report', {
          nonce,
          pane: 'pane-a',
          client,
          sample: { ...sample, credentials: 'secret' },
        })
      ).status,
    ).toBe(400);
    const big = await t.app.request('/report', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: ' '.repeat(4097),
    });
    expect(big.status).toBe(400);
    expect(await big.text()).not.toContain('secret');
    expect((await t.get()).headers.get('cache-control')).toBe('no-store');
  });
  it('rearm clears reports and invalidates old nonce; read/report never prolong TTL', async () => {
    const t = setup();
    const old = await t.arm();
    await t.post('report', { nonce: old, pane: 'pane-a', client, sample });
    const nonce = await t.arm();
    expect(nonce).not.toBe(old);
    expect((await (await t.get('results')).json()).clients).toEqual([]);
    expect((await t.post('report', { nonce: old, pane: 'pane-a', client, sample })).status).toBe(
      409,
    );
    t.tick(299999);
    await t.get();
    t.tick(1);
    expect(await (await t.get('results')).json()).toEqual({ enabled: false });
    expect((await t.post('report', { nonce, pane: 'pane-a', client, sample })).status).toBe(409);
  });
  it('limits four jars, twenty samples each and per-client request rate', async () => {
    const t = setup();
    const nonce = await t.arm();
    for (let i = 0; i < 4; i++) {
      const id = `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
      expect((await t.post('report', { nonce, pane: 'pane-a', client: id, sample })).status).toBe(
        200,
      );
    }
    expect((await t.post('report', { nonce, pane: 'pane-a', client, sample })).status).toBe(429);
    const id = '11111111-1111-4111-8111-000000000000';
    expect((await t.post('report', { nonce, pane: 'pane-a', client: id, sample })).status).toBe(
      429,
    );
    for (let i = 1; i < 20; i++) {
      t.tick(2000);
      expect((await t.post('report', { nonce, pane: 'pane-a', client: id, sample })).status).toBe(
        200,
      );
    }
    t.tick(2000);
    expect((await t.post('report', { nonce, pane: 'pane-a', client: id, sample })).status).toBe(
      429,
    );
  });
  it('disarms and reports never turn themselves into requests or approval', async () => {
    const t = setup();
    const nonce = await t.arm();
    expect((await t.post('report', { nonce, pane: 'pane-b', client, sample })).status).toBe(409);
    await t.post('disarm', {});
    expect(await (await t.get()).json()).toEqual({ enabled: false });
    expect((await t.post('report', { nonce, pane: 'pane-a', client, sample })).status).toBe(409);
  });
});

it('bounds hanging chunked bodies, concurrent work and releases slots after deadline', async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    const pending = Array.from({ length: 4 }, () =>
      t.app.request('/arm', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: new ReadableStream(),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((await t.post('arm', { pane: 'pane-a' })).status).toBe(429);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([400, 400, 400, 400]);
    expect((await t.post('arm', { pane: 'pane-a' })).status).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});
it('accepts the app proxy-aware HTTPS origin over HTTP upstream, rejects foreign and opaque origins', async () => {
  const t = setup();
  const r = await t.app.request('http://muxpad.example/arm', {
    method: 'POST',
    headers: {
      Host: 'muxpad.example',
      Origin: 'https://muxpad.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ pane: 'pane-a' }),
  });
  expect(r.status).toBe(200);
  expect((await r.json()).nonce).toMatch(/^[a-f0-9-]{36}$/);
  for (const origin of ['https://evil.example', 'null'])
    expect(
      (
        await t.app.request('http://muxpad.example/report', {
          method: 'POST',
          headers: { Host: 'muxpad.example', Origin: origin, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
});
