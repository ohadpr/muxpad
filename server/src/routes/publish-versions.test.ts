import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Funnel } from '../funnel.js';
import { createPublicApp } from '../public-server.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';
import { PUBLISH_VERSIONS_KEEP, versionDirName } from './publish.js';

/** Never execs tailscale — these tests must be incapable of exposing anything. */
const funnel: Funnel = {
  async ensure() {
    return { baseUrl: 'https://example.ts.net:8443' };
  },
};

interface PublishBody {
  slug: string;
  url: string;
  files: number;
  bytes: number;
  versions: { n: number; url: string }[];
}
interface ListBody {
  publishes: {
    slug: string;
    url: string | null;
    versions: { n: number; files: number; bytes: number; created: number; url: string | null }[];
  }[];
}

describe('artifact versions', () => {
  let test: TestApp;
  let db: Database.Database;
  let dataDir: string;
  let srcDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-versions-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-versions-src-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir, publish: { funnel } });
  });

  afterEach(async () => {
    await test.cleanup();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Publish `text` as index.html under `slug`, returning the parsed body. */
  async function publish(slug: string, text: string, opts: { update?: boolean } = {}) {
    const dir = join(srcDir, 'site');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), text);
    const res = await post({ path: dir, name: slug, ...(opts.update ? { update: true } : {}) });
    return { res, body: (await res.json()) as PublishBody };
  }

  const publicFile = (dirName: string) =>
    readFileSync(join(dataDir, 'public', dirName, 'index.html'), 'utf-8');

  it('republishing rotates the previous copy to @2 and keeps both readable', async () => {
    await publish('site', 'v1');
    const second = await publish('site', 'v2');
    expect(second.res.status).toBe(201);
    expect(publicFile('site')).toBe('v2');
    expect(publicFile(versionDirName('site', 2))).toBe('v1');
    expect(second.body.versions).toEqual([{ n: 2, url: 'https://example.ts.net:8443/site@2/' }]);
  });

  it('shifts the chain up on every republish and caps retention', async () => {
    // KEEP previous versions means dirs @2 … @(KEEP+1).
    const total = PUBLISH_VERSIONS_KEEP + 3;
    for (let i = 1; i <= total; i++) await publish('site', `v${i}`);
    expect(publicFile('site')).toBe(`v${total}`);
    for (let n = 2; n <= PUBLISH_VERSIONS_KEEP + 1; n++) {
      // @2 is the previous publish, @3 the one before it, …
      expect(publicFile(versionDirName('site', n))).toBe(`v${total - n + 1}`);
    }
    // Everything past the cap is gone — history is a rollback aid, not an
    // unbounded mirror of every build ever made.
    expect(
      existsSync(join(dataDir, 'public', versionDirName('site', PUBLISH_VERSIONS_KEEP + 2))),
    ).toBe(false);
  });

  it('a first publish has no versions', async () => {
    const first = await publish('fresh', 'v1');
    expect(first.body.versions).toEqual([]);
  });

  it('versions are served by the public app at /<slug>@<n>/', async () => {
    await publish('site', 'v1');
    await publish('site', 'v2');
    const pub = createPublicApp(join(dataDir, 'public'));
    expect(await (await pub.request('http://p/site/')).text()).toBe('v2');
    expect(await (await pub.request('http://p/site@2/')).text()).toBe('v1');
    // …and a version that does not exist is a plain 404, not a listing.
    expect((await pub.request('http://p/site@9/')).status).toBe(404);
  });

  it('the public root still 404s — there is no gallery', async () => {
    await publish('site', 'v1');
    await publish('site', 'v2');
    const pub = createPublicApp(join(dataDir, 'public'));
    // Enumerable artifacts would be a leak: knowing the hostname must reveal
    // nothing. The gallery lives inside the (tailnet-only) muxpad UI.
    for (const path of ['http://p/', 'http://p/index.html']) {
      expect((await pub.request(path)).status).toBe(404);
    }
  });

  it('the listing reports versions, and never as artifacts of their own', async () => {
    await publish('site', 'v1');
    await publish('site', 'v2');
    await publish('other', 'x');
    const list = (await (await test.app.request('/api/publish')).json()) as ListBody;
    expect(list.publishes.map((p) => p.slug).sort()).toEqual(['other', 'site']);
    const site = list.publishes.find((p) => p.slug === 'site');
    expect(site?.versions).toHaveLength(1);
    expect(site?.versions[0]?.n).toBe(2);
    expect(site?.versions[0]?.files).toBe(1);
    expect(site?.versions[0]?.url).toBe('https://example.ts.net:8443/site@2/');
    // The CURRENT artifact's byte count is its own, not the whole history's —
    // one of the reasons versions are siblings rather than nested.
    expect(site?.versions[0]?.bytes).toBe(2);
  });

  it('the listing has no url until a public base is known, rather than a fake one', async () => {
    // A brand-new instance has never published, so nothing has persisted a
    // base. Printing a localhost URL here would look shareable and not be.
    const fresh = mkdtempSync(join(tmpdir(), 'muxpad-versions-nobase-'));
    mkdirSync(join(fresh, 'public', 'thing'), { recursive: true });
    writeFileSync(join(fresh, 'public', 'thing', 'index.html'), 'x');
    const db2 = openDb(':memory:');
    const t2 = await createTestApp({ db: db2, dataDir: fresh, publish: { funnel } });
    const list = (await (await t2.app.request('/api/publish')).json()) as ListBody;
    expect(list.publishes[0]?.url).toBeNull();
    await t2.cleanup();
    db2.close();
    rmSync(fresh, { recursive: true, force: true });
  });

  it('deleting an artifact takes its versions off the internet too', async () => {
    await publish('site', 'v1');
    await publish('site', 'v2');
    expect(existsSync(join(dataDir, 'public', versionDirName('site', 2)))).toBe(true);
    const del = await test.app.request('/api/publish/site', { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(existsSync(join(dataDir, 'public', 'site'))).toBe(false);
    // Leaving @2 behind would keep serving content the user believed they had
    // removed from the internet.
    expect(existsSync(join(dataDir, 'public', versionDirName('site', 2)))).toBe(false);
    const pub = createPublicApp(join(dataDir, 'public'));
    expect((await pub.request('http://p/site@2/')).status).toBe(404);
  });
});

describe('publish --update', () => {
  let test: TestApp;
  let db: Database.Database;
  let dataDir: string;
  let srcDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-update-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-update-src-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir, publish: { funnel } });
    writeFileSync(join(srcDir, 'page.html'), 'body');
  });

  afterEach(async () => {
    await test.cleanup();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses to CREATE — a typo is a readable 404, not a seventh artifact', async () => {
    const res = await post({ path: join(srcDir, 'page.html'), name: 'typoo', update: true });
    expect(res.status).toBe(404);
    expect(existsSync(join(dataDir, 'public', 'typoo'))).toBe(false);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/publish it first/);
  });

  it('replaces an existing artifact in place, rotating the old copy', async () => {
    await post({ path: join(srcDir, 'page.html'), name: 'thing' });
    writeFileSync(join(srcDir, 'page.html'), 'body2');
    const res = await post({ path: join(srcDir, 'page.html'), name: 'thing', update: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PublishBody;
    expect(body.slug).toBe('thing');
    expect(readFileSync(join(dataDir, 'public', 'thing', 'index.html'), 'utf-8')).toBe('body2');
    expect(readFileSync(join(dataDir, 'public', 'thing@2', 'index.html'), 'utf-8')).toBe('body');
  });

  it('requires a name — "update the unnamed one" is meaningless', async () => {
    const res = await post({ path: join(srcDir, 'page.html'), update: true });
    expect(res.status).toBe(400);
  });
});

describe('the public base every link is built from', () => {
  let test: TestApp;
  let db: Database.Database;
  let dataDir: string;
  let srcDir: string;
  /** Ephemeral by nature — a VALUE here, never a constant in src/. */
  const TUNNEL = 'https://part-anonymous-brilliant-resume.trycloudflare.com';
  const FUNNEL = 'https://dt-mac-mini.west-hydra.ts.net:8443';
  let reachable: Set<string>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-base-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-base-src-'));
    db = openDb(':memory:');
    reachable = new Set([TUNNEL, FUNNEL]);
    test = await createTestApp({
      db,
      dataDir,
      publish: {
        funnel: {
          async ensure() {
            return { baseUrl: FUNNEL };
          },
        },
        baseProbe: async (url) => ({
          alive: reachable.has(url.replace(/\/$/, '')),
          status: 404,
          reason: 'client_error',
          elapsedMs: 1,
        }),
      },
    });
    writeFileSync(join(srcDir, 'p.html'), 'x');
  });

  afterEach(async () => {
    await test.cleanup();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const req = (p: string, init?: RequestInit) => test.app.request(`http://local${p}`, init);
  const setBase = (url: string) =>
    req('/api/publish/base', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  const publish = (body: unknown) =>
    req('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('a pinned base wins over the funnel hint, on publish AND in the listing', async () => {
    expect((await setBase(TUNNEL)).status).toBe(200);
    // Every `muxpad publish` sends the funnel url as a hint — the exact input
    // that used to overwrite a working base.
    const body = (await (
      await publish({ path: join(srcDir, 'p.html'), name: 'demo', public_base_url: FUNNEL })
    ).json()) as PublishBody;
    expect(body.url).toBe(`${TUNNEL}/demo/`);

    // …and the listing agrees, because both go through one resolver. This is
    // the property that stops the UI and the CLI printing different links.
    const list = (await (await req('/api/publish')).json()) as ListBody & {
      base: { url: string; source: string; reachable: boolean | null };
    };
    expect(list.publishes[0]?.url).toBe(`${TUNNEL}/demo/`);
    expect(list.base).toMatchObject({ url: TUNNEL, source: 'pinned', reachable: true });
  });

  it('versions use the same base as their artifact', async () => {
    await setBase(TUNNEL);
    await publish({ path: join(srcDir, 'p.html'), name: 'demo' });
    writeFileSync(join(srcDir, 'p.html'), 'y');
    await publish({ path: join(srcDir, 'p.html'), name: 'demo', update: true });
    const list = (await (await req('/api/publish')).json()) as ListBody;
    const one = list.publishes[0];
    expect(one?.url).toBe(`${TUNNEL}/demo/`);
    expect(one?.versions[0]?.url).toBe(`${TUNNEL}/demo@2/`);
  });

  it('reports a base that has stopped answering instead of handing out dead links', async () => {
    await setBase(TUNNEL);
    reachable.clear(); // the quick tunnel's process exits
    const list = (await (await req('/api/publish')).json()) as ListBody & {
      base: { reachable: boolean | null; warning?: string };
    };
    expect(list.base.reachable).toBe(false);
    expect(list.base.warning).toMatch(/not answering/);
  });

  it('falls through to the next candidate when the pin is dead but a fallback lives', async () => {
    await setBase(TUNNEL);
    await publish({ path: join(srcDir, 'p.html'), name: 'demo', public_base_url: FUNNEL });
    reachable.delete(TUNNEL);
    const list = (await (await req('/api/publish')).json()) as ListBody & {
      base: { url: string; source: string };
    };
    expect(list.base).toMatchObject({ url: FUNNEL, source: 'persisted' });
  });

  it('GET /base explains the whole chain, and DELETE drops the pin', async () => {
    await setBase(TUNNEL);
    await publish({ path: join(srcDir, 'p.html'), name: 'demo', public_base_url: FUNNEL });
    const shown = (await (await req('/api/publish/base')).json()) as {
      url: string;
      source: string;
      candidates: { url: string; source: string }[];
    };
    expect(shown).toMatchObject({ url: TUNNEL, source: 'pinned' });
    expect(shown.candidates).toEqual([
      { url: TUNNEL, source: 'pinned' },
      { url: FUNNEL, source: 'persisted' },
    ]);

    const cleared = (await (await req('/api/publish/base', { method: 'DELETE' })).json()) as {
      url: string;
      source: string;
    };
    expect(cleared).toMatchObject({ url: FUNNEL, source: 'persisted' });
  });

  it('refuses a malformed base rather than storing a link that cannot work', async () => {
    for (const url of ['not a url', 'https://x.example/path', 'http://public.example', '']) {
      const res = await setBase(url);
      expect(res.status).toBe(400);
    }
    const shown = (await (await req('/api/publish/base')).json()) as { url: string | null };
    expect(shown.url).toBeNull();
  });

  it('reports no url at all rather than a loopback one that looks copyable', async () => {
    // Nothing configured, nothing pinned, funnel down.
    const down = await createTestApp({
      db: openDb(':memory:'),
      dataDir,
      publish: {
        funnel: {
          async ensure() {
            return { baseUrl: 'http://127.0.0.1:7778', warning: 'funnel unavailable' };
          },
        },
      },
    });
    try {
      const list = (await (
        await down.app.request('http://local/api/publish')
      ).json()) as ListBody & { base: { url: string | null; source: string } };
      expect(list.base).toMatchObject({ url: null, source: 'local' });
    } finally {
      await down.cleanup();
    }
  });
});
