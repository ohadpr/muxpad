import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppRegistry, createAppRegistry } from '../apps/AppRegistry.js';
import type { Funnel } from '../funnel.js';
import { PUBLIC_BASE_URL_KEY } from '../public-base.js';
import { AppStore } from '../store/AppStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
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
   * THE RANKING, end to end through HTTP — the defect that killed every link in
   * the conversation that produced this feature.
   *
   * Both candidates are present: an ephemeral quick-tunnel name and a durable
   * tailnet one. The tunnel used to win, so `muxpad publish` printed a link with
   * a shelf life of hours and said nothing until 416c9cc. Now the durable one
   * wins by default and the tunnel is something you ASK for.
   */
  describe('audience — the default link is the durable one', () => {
    const TAILNET = 'https://example-host.example-tailnet.ts.net:8443';

    const publish = (name: string, audience?: string) =>
      test.app.request('/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: srcDir, name, ...(audience ? { audience } : {}) }),
      });

    beforeEach(async () => {
      new GlobalsStore(db).set(PUBLIC_BASE_URL_KEY, TAILNET);
      await ensure();
      await announce(FIRST, paneOfTunnel());
      expect(tunnelBaseUrl(db)).toBe(FIRST);
    });

    it('publishes under the tailnet base, not the tunnel', async () => {
      const body = (await (await publish('report')).json()) as {
        url: string;
        base: { source: string; durability: string; note?: string };
      };
      expect(body.url).toBe(`${TAILNET}/report/`);
      expect(body.base.durability).toBe('tailnet');
      // …and says what that means, in both directions.
      expect(body.base.note).toContain('every device on your tailnet');
      expect(body.base.note).toContain('--public');
    });

    it('publishes under the tunnel when a public link is asked for', async () => {
      const body = (await (await publish('report', 'public')).json()) as {
        url: string;
        base: { durability: string; note?: string };
      };
      expect(body.url).toBe(`${FIRST}/report/`);
      expect(body.base.durability).toBe('ephemeral');
      // The ephemeral warning is the whole reason `--public` is a flag and not
      // the default: you get the link you asked for AND its shelf life.
      expect(body.base.note).toContain('quick tunnel');
      expect(body.base.note).toContain('muxpad publish --url');
    });

    it('the LISTING is durable by default — it is the recovery surface', async () => {
      await publish('report');
      const list = (await (await test.app.request('/api/publish')).json()) as {
        publishes: Array<{ slug: string; url: string }>;
      };
      expect(list.publishes.find((p) => p.slug === 'report')?.url).toBe(`${TAILNET}/report/`);
      const pub = (await (await test.app.request('/api/publish?audience=public')).json()) as {
        publishes: Array<{ slug: string; url: string }>;
      };
      expect(pub.publishes.find((p) => p.slug === 'report')?.url).toBe(`${FIRST}/report/`);
    });

    it('`--base` reports the audience and orders its table to match', async () => {
      const dflt = (await (await test.app.request('/api/publish/base')).json()) as {
        audience: string;
        durability: string;
        candidates: Array<{ durability: string }>;
      };
      expect(dflt.audience).toBe('tailnet');
      expect(dflt.durability).toBe('tailnet');
      expect(dflt.candidates.map((c) => c.durability)).toEqual(['tailnet', 'ephemeral']);

      const pub = (await (await test.app.request('/api/publish/base?audience=public')).json()) as {
        audience: string;
        durability: string;
        candidates: Array<{ durability: string }>;
      };
      expect(pub.audience).toBe('public');
      expect(pub.durability).toBe('ephemeral');
      expect(pub.candidates.map((c) => c.durability)).toEqual(['ephemeral', 'tailnet']);
    });

    it('an unknown audience means the DURABLE one, never the expiring one', async () => {
      // A typo, or an older CLI. Guessing wrong in this direction prints a link
      // that works and is private; guessing wrong the other way prints one that
      // dies.
      const body = (await (await publish('report', 'pubic')).json()) as { url: string };
      expect(body.url).toBe(`${TAILNET}/report/`);
    });
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
