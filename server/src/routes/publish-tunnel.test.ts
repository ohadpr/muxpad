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

  /**
   * THE ACTUAL DEFECT, at the surface where it was shipped.
   *
   * Every link published between 2026-09-19 and 2026-09-27 was printed under
   * one quick-tunnel hostname and died together when ptyd restarted on the
   * 27th. At no point did any response say the link had a shelf life — the
   * publish returned `reachable: true` and a url, which is precisely what a
   * permanent link looks like.
   */
  it('the publish response says the link is EPHEMERAL, at the moment it hands it over', async () => {
    await ensure();
    await announce(FIRST, paneOfTunnel());
    const res = await test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcDir, name: 'report' }),
    });
    const body = (await res.json()) as {
      url: string;
      base: { durability: string; note?: string; source: string };
    };
    expect(body.url).toBe(`${FIRST}/report/`);
    expect(body.base.source).toBe('tunnel');
    expect(body.base.durability).toBe('ephemeral');
    expect(body.base.note).toContain('quick tunnel');
    // And it names the recovery, because the artifact outlives the address:
    // the bytes are still on disk under the slug long after the host is gone.
    expect(body.base.note).toContain('muxpad publish --url');
  });

  it('measures the tunnel it serves, instead of reporting "not checked"', async () => {
    await ensure();
    await announce(FIRST, paneOfTunnel());
    const base = (await (await test.app.request('/api/publish/base')).json()) as {
      source: string;
      reachable: boolean | null;
      durability: string;
    };
    expect(base.source).toBe('tunnel');
    expect(base.durability).toBe('ephemeral');
    // No cloudflared in a test, so the probe genuinely fails — the assertion is
    // that an ANSWER is reported, and that a failed probe still does not unseat
    // the tunnel (see public-base.ts: a false negative would swap a working
    // public link for a blocked :8443 one).
    expect(base.reachable).not.toBeNull();
  });

  /**
   * A tunnel supervised OUTSIDE muxpad (the launchd job in docs/launchd.md §3).
   * `process.pid` stands in for the runner's, because it is a pid that is
   * genuinely alive — the liveness check is a real syscall, not a stub.
   */
  it('a paneless runner owns the tunnel by pid, with no app row anywhere', async () => {
    const res = await test.app.request('/api/publish/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: FIRST, pid: process.pid }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: FIRST, active: true, wanted: true });
    expect(tunnelBaseUrl(db)).toBe(FIRST);
    expect(new AppStore(db).getBySlug(TUNNEL_APP_SLUG)).toBeNull();

    const got = (await (await test.app.request('/api/publish/tunnel')).json()) as {
      url: string | null;
      owner: string | null;
    };
    expect(got).toMatchObject({ url: FIRST, owner: 'process' });
  });

  it('a url-less POST is a CLAIM, not an answer', async () => {
    const res = await test.app.request('/api/publish/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: process.pid }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: null, owner: 'process' });
    expect(tunnelBaseUrl(db)).toBeNull();
    // And it still holds the tunnel, so a publish in this window does not start
    // a rival one in a pane.
    const pub = await test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcDir, name: 'report' }),
    });
    expect(pub.status).toBe(201);
    expect(new AppStore(db).getBySlug(TUNNEL_APP_SLUG)).toBeNull();
  });

  it('a retraction WITH a pid keeps the claim; one without deletes the record', async () => {
    const retract = (body: Record<string, unknown>) =>
      test.app.request('/api/publish/tunnel', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    await test.app.request('/api/publish/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: FIRST, pid: process.pid }),
    });
    await retract({ error: 'cloudflared exited (code 1) after 2s', attempts: 1, pid: process.pid });
    let got = (await (await test.app.request('/api/publish/tunnel')).json()) as {
      url: string | null;
      owner: string | null;
    };
    expect(got).toMatchObject({ url: null, owner: 'process' });

    await retract({});
    got = (await (await test.app.request('/api/publish/tunnel')).json()) as {
      url: string | null;
      owner: string | null;
    };
    expect(got.owner).toBeNull();
  });

  it('a url-less POST with no pid is a bad request, not a silent no-op', async () => {
    const res = await test.app.request('/api/publish/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
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

  it('tells a launchd-supervised runner it is NOT WANTED, since muxpad cannot stop it', async () => {
    // The whole reason the tunnel now survives a muxpad restart is that muxpad
    // no longer owns the process — so `env` can no longer cancel the tunnel by
    // stopping an app. The announce response is the channel instead, and the
    // runner shuts itself down on `wanted: false` (tunnel/run.ts).
    const res = await test.app.request('/api/publish/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: FIRST, pid: process.pid }),
    });
    expect(await res.json()).toMatchObject({ wanted: false, active: false });
  });
});
