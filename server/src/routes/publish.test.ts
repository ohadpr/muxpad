import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Funnel, FunnelState } from '../funnel.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';
import { PUBLIC_BASE_URL_KEY } from './publish.js';

/**
 * A funnel stub that records ensure() calls and never execs anything —
 * these tests must be incapable of exposing content publicly.
 */
function stubFunnel(state: FunnelState): Funnel & { calls: number } {
  const stub = {
    calls: 0,
    async ensure() {
      stub.calls += 1;
      return state;
    },
  };
  return stub;
}

describe('publish routes', () => {
  let test: TestApp;
  let db: Database.Database;
  let dataDir: string;
  let srcDir: string;
  let funnel: Funnel & { calls: number };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-publish-'));
    srcDir = mkdtempSync(join(tmpdir(), 'muxpad-publish-src-'));
    funnel = stubFunnel({ baseUrl: 'https://example.ts.net:8443' });
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir, publish: { funnel } });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    test.app.request('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('publishes a lone html file as <slug>/index.html', async () => {
    const src = join(srcDir, 'report.html');
    writeFileSync(src, '<h1>hi</h1>');
    const res = await post({ path: src });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      slug: string;
      url: string;
      files: number;
      bytes: number;
      warning?: string;
    };
    expect(body.slug).toMatch(/^[0-9a-f]{8}$/);
    expect(body.url).toBe(`https://example.ts.net:8443/${body.slug}/`);
    expect(body.files).toBe(1);
    expect(body.bytes).toBe(11);
    expect(body.warning).toBeUndefined();
    expect(funnel.calls).toBe(1);
    const copied = readFileSync(join(dataDir, 'public', body.slug, 'index.html'), 'utf-8');
    expect(copied).toBe('<h1>hi</h1>');
  });

  it('publishes a non-html file under its own name', async () => {
    const src = join(srcDir, 'data.csv');
    writeFileSync(src, 'a,b\n1,2\n');
    const res = await post({ path: src, name: 'my-data' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; url: string };
    expect(body.slug).toBe('my-data');
    expect(readFileSync(join(dataDir, 'public', 'my-data', 'data.csv'), 'utf-8')).toBe(
      'a,b\n1,2\n',
    );
  });

  it('publishes a directory recursively (symlinks dereferenced)', async () => {
    const site = join(srcDir, 'site');
    mkdirSync(join(site, 'assets'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<html>site</html>');
    writeFileSync(join(site, 'assets', 'app.js'), 'console.log(1)');
    // A symlink inside the source becomes a regular file in the public tree.
    writeFileSync(join(srcDir, 'outside.txt'), 'outside');
    symlinkSync(join(srcDir, 'outside.txt'), join(site, 'linked.txt'));
    const res = await post({ path: site, name: 'site' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { files: number };
    expect(body.files).toBe(3);
    const linked = join(dataDir, 'public', 'site', 'linked.txt');
    expect(readFileSync(linked, 'utf-8')).toBe('outside');
    // The public tree must hold only regular files — the source symlink was
    // dereferenced on copy, so the static server's containment check is moot.
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
  });

  it('republishing a named slug overwrites in place', async () => {
    const src = join(srcDir, 'page.html');
    writeFileSync(src, 'v1');
    await post({ path: src, name: 'page' });
    writeFileSync(src, 'v2 longer');
    const res = await post({ path: src, name: 'page' });
    expect(res.status).toBe(201);
    expect(readFileSync(join(dataDir, 'public', 'page', 'index.html'), 'utf-8')).toBe('v2 longer');
  });

  it('a failed republish leaves the previous version intact and complete', async () => {
    // Staging + atomic rename. Before it, republish `rmSync`'d the live
    // destination and copied straight in, so ANY failure (disk full, perms,
    // the source vanishing) destroyed the last good artifact and left a
    // partial one. Simulate the failure by making the source unreadable
    // between the two publishes.
    const dir = join(srcDir, 'site');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), 'v1');
    expect((await post({ path: dir, name: 'page' })).status).toBe(201);

    const sub = join(dir, 'deep');
    mkdirSync(sub);
    writeFileSync(join(sub, 'a.html'), 'v2');
    writeFileSync(join(dir, 'index.html'), 'v2');
    chmodSync(sub, 0o000); // copyDereferenced will throw on readdirSync
    let res: Response;
    try {
      res = await post({ path: dir, name: 'page' });
    } finally {
      chmodSync(sub, 0o755);
    }
    expect(res.status).toBe(500);
    // v1 is still there, whole, and there is no half-written replacement.
    expect(readFileSync(join(dataDir, 'public', 'page', 'index.html'), 'utf-8')).toBe('v1');
    expect(existsSync(join(dataDir, 'public', 'page', 'deep'))).toBe(false);
    // The staging dir is cleaned up, and never shows up as a publish.
    const listed = (await (await test.app.request('/api/publish')).json()) as {
      publishes: Array<{ slug: string }>;
    };
    expect(listed.publishes.map((p) => p.slug)).toEqual(['page']);
    expect(readdirSync(join(dataDir, 'public')).filter((e) => e.startsWith('.'))).toEqual([]);
  });

  it('skips a nested symlink pointing INSIDE the public dir (the recursion hole)', async () => {
    // The nested guard rejected the public dir and its ANCESTORS but not its
    // DESCENDANTS. Publishing a source containing `loop -> <public>/site` to
    // slug `site` created the destination and then copied it into itself,
    // site/loop/loop/… down to the depth cap: huge amplification,
    // ENAMETOOLONG, disk exhaustion and a long synchronous event-loop stall.
    const publicDir = join(dataDir, 'public');
    mkdirSync(publicDir, { recursive: true });
    const dir = join(srcDir, 'site');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), 'ok');
    symlinkSync(join(publicDir, 'site'), join(dir, 'loop'));
    // First publish creates <public>/site so the link resolves on the second.
    expect((await post({ path: dir, name: 'site' })).status).toBe(201);
    const res = await post({ path: dir, name: 'site' });
    expect(res.status).toBe(201);
    expect(readFileSync(join(publicDir, 'site', 'index.html'), 'utf-8')).toBe('ok');
    expect(existsSync(join(publicDir, 'site', 'loop'))).toBe(false);
    expect((await res.json()) as { files: number }).toMatchObject({ files: 1 });
  });

  it('rejects invalid names', async () => {
    const src = join(srcDir, 'x.txt');
    writeFileSync(src, 'x');
    for (const name of ['Bad', 'has space', 'dots..', 'a/b', '', 'a'.repeat(65)]) {
      const res = await post({ path: src, name });
      expect(res.status, `name ${JSON.stringify(name)}`).toBe(400);
    }
  });

  it('rejects relative paths', async () => {
    const res = await post({ path: 'relative/thing.html' });
    expect(res.status).toBe(400);
  });

  it('404s on a missing source path', async () => {
    const res = await post({ path: join(srcDir, 'nope.html') });
    expect(res.status).toBe(404);
  });

  it('refuses to publish the public dir into itself', async () => {
    const src = join(srcDir, 'a.txt');
    writeFileSync(src, 'a');
    await post({ path: src, name: 'seed' });
    for (const path of [join(dataDir, 'public'), dataDir, join(dataDir, 'public', 'seed')]) {
      const res = await post({ path });
      expect(res.status, path).toBe(400);
    }
  });

  it('refuses to publish filesystem roots (the `/` ancestor-guard bypass)', async () => {
    // realSrc='/' made the naive `realSrc + sep` prefix '//', which never
    // matched — `publish /` would have mirrored the whole filesystem into
    // the publicly served dir. Root must 400 like any other ancestor.
    const res = await post({ path: '/' });
    expect(res.status).toBe(400);
  });

  it('skips nested symlinks that resolve to the public dir or its ancestors', async () => {
    // A nested `link -> <ancestor of publicDir>` would re-enter our own
    // output (unbounded blow-up) and mirror sensitive trees. The top-level
    // guard can't see nested links; copyDereferenced must skip them.
    const dir = join(srcDir, 'site');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), 'ok');
    symlinkSync(dataDir, join(dir, 'sneaky')); // ancestor of publicDir
    const res = await post({ path: dir, name: 'sym' });
    expect(res.status).toBe(201);
    expect(readFileSync(join(dataDir, 'public', 'sym', 'index.html'), 'utf-8')).toBe('ok');
    expect(existsSync(join(dataDir, 'public', 'sym', 'sneaky'))).toBe(false);
  });

  it('still publishes (with warning + local url) when the funnel is down', async () => {
    const downFunnel = stubFunnel({
      baseUrl: 'http://127.0.0.1:7778',
      warning: 'tailscale funnel unavailable — URL is local-only: boom',
    });
    const down = await createTestApp({
      db: openDb(':memory:'),
      dataDir,
      publish: { funnel: downFunnel },
    });
    try {
      const src = join(srcDir, 'r.html');
      writeFileSync(src, 'r');
      const res = await down.app.request('/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: src, name: 'r' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { url: string; warning?: string };
      expect(body.url).toBe('http://127.0.0.1:7778/r/');
      expect(body.warning).toContain('funnel unavailable');
    } finally {
      await down.cleanup();
    }
  });

  it('uses + persists a public_base_url hint without consulting the funnel', async () => {
    const src = join(srcDir, 'h.html');
    writeFileSync(src, 'h');
    const res = await post({
      path: src,
      name: 'hinted',
      public_base_url: 'https://dt-mac-mini.west-hydra.ts.net:8443/',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string; warning?: string };
    expect(body.url).toBe('https://dt-mac-mini.west-hydra.ts.net:8443/hinted/');
    expect(body.warning).toBeUndefined();
    // Hint short-circuits discovery entirely (launchd path: the server-side
    // CLI can't run anyway) and is persisted for later hint-less publishes.
    expect(funnel.calls).toBe(0);
    expect(new GlobalsStore(db).get(PUBLIC_BASE_URL_KEY)).toBe(
      'https://dt-mac-mini.west-hydra.ts.net:8443',
    );
  });

  it('rejects malformed public_base_url hints with 400, before copying', async () => {
    const src = join(srcDir, 'h.html');
    writeFileSync(src, 'h');
    const bad = [
      'http://insecure.ts.net:8443', // not https
      'garbage',
      '',
      'https://x.ts.net:8443/some/path',
      'https://x.ts.net:8443/?q=1',
      'https://x.ts.net:8443/#frag',
      'https://user:pw@x.ts.net:8443',
      42,
      { url: 'https://x.ts.net' },
    ];
    for (const hint of bad) {
      const res = await post({ path: src, name: 'never', public_base_url: hint });
      expect(res.status, JSON.stringify(hint)).toBe(400);
    }
    // Validation happens before any copying — nothing was published.
    const list = (await (await test.app.request('/api/publish')).json()) as {
      publishes: Array<{ slug: string }>;
    };
    expect(list.publishes.find((p) => p.slug === 'never')).toBeUndefined();
    expect(new GlobalsStore(db).get(PUBLIC_BASE_URL_KEY)).toBeNull();
  });

  it('persists the base url on successful server-side discovery', async () => {
    const src = join(srcDir, 'd.html');
    writeFileSync(src, 'd');
    await post({ path: src });
    expect(new GlobalsStore(db).get(PUBLIC_BASE_URL_KEY)).toBe('https://example.ts.net:8443');
  });

  it('falls back to the persisted base url (no warning) when discovery warns', async () => {
    new GlobalsStore(db).set(PUBLIC_BASE_URL_KEY, 'https://saved.ts.net:8443');
    const downFunnel = stubFunnel({
      baseUrl: 'http://127.0.0.1:7778',
      warning: 'tailscale funnel unavailable — URL is local-only: CLIError 3',
    });
    const down = await createTestApp({ db, dataDir, publish: { funnel: downFunnel } });
    try {
      const src = join(srcDir, 'f.html');
      writeFileSync(src, 'f');
      const res = await down.app.request('/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: src, name: 'f' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { url: string; warning?: string };
      expect(body.url).toBe('https://saved.ts.net:8443/f/');
      // A persisted base is a known-public URL — the discovery warning is
      // NOT surfaced.
      expect(body.warning).toBeUndefined();
      expect(downFunnel.calls).toBe(1);
    } finally {
      await down.cleanup();
    }
  });

  it('lists publishes with slug, files, bytes, created', async () => {
    const src = join(srcDir, 'x.html');
    writeFileSync(src, 'xx');
    await post({ path: src, name: 'one' });
    await post({ path: src, name: 'two' });
    const res = await test.app.request('/api/publish');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publishes: Array<{ slug: string; files: number; bytes: number; created: number }>;
    };
    expect(body.publishes.map((p) => p.slug).sort()).toEqual(['one', 'two']);
    for (const p of body.publishes) {
      expect(p.files).toBe(1);
      expect(p.bytes).toBe(2);
      expect(p.created).toBeGreaterThan(0);
    }
  });

  it('deletes a publish; delete of unknown slug 404s; bad slug 400s', async () => {
    const src = join(srcDir, 'x.html');
    writeFileSync(src, 'x');
    await post({ path: src, name: 'gone' });
    const del = await test.app.request('/api/publish/gone', { method: 'DELETE' });
    expect(del.status).toBe(204);
    const list = (await (await test.app.request('/api/publish')).json()) as {
      publishes: unknown[];
    };
    expect(list.publishes).toHaveLength(0);
    expect((await test.app.request('/api/publish/gone', { method: 'DELETE' })).status).toBe(404);
    // Traversal-shaped slugs must be rejected. Literal `..` collapses in URL
    // normalization and `%2e%2e` is refused by Hono's router itself (404);
    // anything that DOES reach the handler fails SLUG_RE (400). Either way:
    // a 4xx, and nothing on disk is touched.
    const enc = await test.app.request('/api/publish/%2e%2e', { method: 'DELETE' });
    expect(enc.status).toBeGreaterThanOrEqual(400);
    expect((await test.app.request('/api/publish/BAD', { method: 'DELETE' })).status).toBe(400);
    expect((await test.app.request('/api/publish/has.dots', { method: 'DELETE' })).status).toBe(
      400,
    );
  });
});
