import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppRegistry, createAppRegistry } from '../apps/AppRegistry.js';
import type { Funnel } from '../funnel.js';
import { AppStore } from '../store/AppStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';
import {
  TUNNEL_APP_SLUG,
  type TunnelEnsureResult,
  ensureTunnelApp,
  tunnelBaseUrl,
} from '../tunnel/TunnelApp.js';

/**
 * The tunnel through the HTTP surface: the announce/retract routes the in-pane
 * process uses, and the lazy start a publish performs.
 */

const FIRST = 'https://franklin-discuss-powers-usgs.trycloudflare.com';
const SECOND = 'https://quiet-mango-parallel-tide.trycloudflare.com';

const localOnlyFunnel: Funnel = {
  async ensure() {
    return { baseUrl: 'http://127.0.0.1:7778', warning: 'funnel disabled in tests' };
  },
};

describe('publish tunnel routes', () => {
  let test: TestApp;
  let db: Database.Database;
  let dataDir: string;
  let srcDir: string;
  let registry: AppRegistry;
  let ensureCalls: number;

  const ensure = async (opts?: { start?: boolean }): Promise<TunnelEnsureResult> => {
    ensureCalls += 1;
    return ensureTunnelApp({
      db,
      registry,
      publicPort: 7778,
      findBin: () => '/x/cloudflared',
      cwd: tmpdir(),
      log: () => {},
      ...(opts?.start !== undefined ? { start: opts.start } : {}),
    });
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-tunnel-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-tunnel-src-'));
    writeFileSync(join(srcDir, 'index.html'), '<h1>hi</h1>');
    db = openDb(':memory:');
    ensureCalls = 0;
    registry = createAppRegistry({
      db,
      ptyd: { ensurePane: async () => {}, killPane: async () => {} },
      log: () => {},
    });
    test = await createTestApp({
      db,
      dataDir,
      publish: { funnel: localOnlyFunnel, tunnel: { ensure, firstUrlWaitMs: 50 } },
    });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const announce = (url: string, paneId?: string | null) =>
    test.app.request('/api/publish/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, pane_id: paneId ?? null }),
    });

  const paneOfTunnel = () => new AppStore(db).getBySlug(TUNNEL_APP_SLUG)?.pane_id ?? null;

  it('a publish registers and starts the tunnel — the lazy half of decision 2', async () => {
    expect(new AppStore(db).getBySlug(TUNNEL_APP_SLUG)).toBeNull();
    const res = await test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcDir, name: 'report' }),
    });
    expect(res.status).toBe(201);
    expect(ensureCalls).toBe(1);
    const app = new AppStore(db).getBySlug(TUNNEL_APP_SLUG);
    expect(app?.enabled).toBe(true);
    expect(app?.command).toBe('muxpad tunnel --port 7778');
    // It waited for a url that never came (no real cloudflared here) and then
    // answered anyway — a tunnel that will not start must never fail a publish.
    expect((await res.json()) as { slug: string }).toMatchObject({ slug: 'report' });
  });

  it('an announced url becomes the base every link is built from', async () => {
    await ensure();
    const res = await announce(FIRST, paneOfTunnel());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: FIRST, active: true, source: 'tunnel' });

    const list = (await (await test.app.request('/api/publish')).json()) as {
      base: { url: string; source: string };
    };
    expect(list.base).toMatchObject({ url: FIRST, source: 'tunnel' });
  });

  it('a restart re-pins: the new hostname replaces the old one', async () => {
    await ensure();
    const pane = paneOfTunnel();
    await announce(FIRST, pane);
    expect(tunnelBaseUrl(db)).toBe(FIRST);

    // cloudflared died…
    const down = await test.app.request('/api/publish/tunnel', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'cloudflared exited (code 1) after 3s', attempts: 1 }),
    });
    expect(down.status).toBe(204);
    expect(tunnelBaseUrl(db)).toBeNull();

    // …and came back under a DIFFERENT name.
    await announce(SECOND, pane);
    const base = (await (await test.app.request('/api/publish/base')).json()) as {
      url: string;
      source: string;
      candidates: Array<{ url: string }>;
    };
    expect(base).toMatchObject({ url: SECOND, source: 'tunnel' });
    expect(base.candidates.some((c) => c.url === FIRST)).toBe(false);
  });

  it('refuses a url that is not an https origin', async () => {
    await ensure();
    for (const bad of ['http://127.0.0.1:7778', 'https://x.example/path', 'nope']) {
      expect((await announce(bad, paneOfTunnel())).status).toBe(400);
    }
    expect(tunnelBaseUrl(db)).toBeNull();
  });

  it('GET /tunnel shows a url that is being IGNORED, not just a missing one', async () => {
    await ensure();
    // Announced by a pane that is not (any more) the tunnel's.
    await announce(FIRST, 'some-other-pane');
    const got = (await (await test.app.request('/api/publish/tunnel')).json()) as {
      url: string | null;
      record: { url: string } | null;
    };
    expect(got.url).toBeNull();
    expect(got.record?.url).toBe(FIRST);
  });

  it('surfaces a tunnel that keeps failing on the base every surface reads', async () => {
    await test.app.request('/api/publish/tunnel', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'connect: network is unreachable', attempts: 6 }),
    });
    const base = (await (await test.app.request('/api/publish/base')).json()) as {
      warning?: string;
    };
    expect(base.warning).toContain('failed to start 6 times');
    expect(base.warning).toContain('muxpad app logs tunnel');
  });
});

describe('publish tunnel routes — MUXPAD_PUBLIC_BASE_URL is set', () => {
  let test: TestApp;
  let db: Database.Database;
  let dataDir: string;
  let srcDir: string;
  let registry: AppRegistry;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-tunnel-env-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-tunnel-env-src-'));
    writeFileSync(join(srcDir, 'index.html'), '<h1>hi</h1>');
    db = openDb(':memory:');
    registry = createAppRegistry({
      db,
      ptyd: { ensurePane: async () => {}, killPane: async () => {} },
      log: () => {},
    });
    test = await createTestApp({
      db,
      dataDir,
      publish: {
        funnel: localOnlyFunnel,
        publicBaseUrl: 'https://artifacts.example.com',
        tunnel: {
          ensure: (opts) =>
            ensureTunnelApp({
              db,
              registry,
              publicPort: 7778,
              configuredBaseUrl: 'https://artifacts.example.com',
              findBin: () => '/x/cloudflared',
              cwd: tmpdir(),
              log: () => {},
              ...(opts?.start !== undefined ? { start: opts.start } : {}),
            }),
          firstUrlWaitMs: 50,
        },
      },
    });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('publishing does not start a tunnel, and the domain is the base', async () => {
    const res = await test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcDir, name: 'report' }),
    });
    expect((await res.json()) as { url: string }).toMatchObject({
      url: 'https://artifacts.example.com/report/',
    });
    expect(new AppStore(db).getBySlug(TUNNEL_APP_SLUG)).toBeNull();
  });

  it('even an announced tunnel url loses to the configured domain', async () => {
    // Belt and braces: the tunnel is not supposed to be running at all, but if
    // one somehow is, it must not displace the permanent base.
    await test.app.request('/api/publish/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: FIRST }),
    });
    const base = (await (await test.app.request('/api/publish/base')).json()) as {
      url: string;
      source: string;
    };
    expect(base).toMatchObject({ url: 'https://artifacts.example.com', source: 'env' });
  });
});
