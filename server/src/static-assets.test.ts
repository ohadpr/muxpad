import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cachePolicy, ifNoneMatchSatisfied, mountStaticWeb } from './static-assets.js';

/**
 * The invalidation contract, pinned. The failure this guards against isn't
 * "slow" — it's a client that pairs a freshly-deployed index.html with a
 * year-cached chunk from the previous build, or caches a 404 for a chunk it
 * asked for mid-deploy. Both are unrecoverable without clearing site data.
 */

let root: string;
let app: Hono;
const JS_BODY = 'x'.repeat(4096);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'muxpad-static-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>muxpad</title>');
  writeFileSync(join(root, 'assets', 'index-abc123.js'), JS_BODY);
  writeFileSync(join(root, 'assets', 'index-abc123.js.br'), brotliCompressSync(JS_BODY));
  writeFileSync(join(root, 'assets', 'index-abc123.js.gz'), gzipSync(JS_BODY));
  // A hashed font: no precompressed sibling (woff2 is already brotli inside).
  writeFileSync(join(root, 'assets', 'mono-abc123.woff2'), 'wOF2fake');
  writeFileSync(join(root, 'sw.js'), 'self.addEventListener("push", () => {});');
  writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"muxpad"}');
  writeFileSync(join(root, 'favicon.svg'), '<svg/>');
  app = new Hono();
  mountStaticWeb(app, root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });

describe('cache policy', () => {
  it('pins content-hashed assets for a year and marks them immutable', () => {
    expect(cachePolicy('/assets/index-abc123.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cachePolicy('/assets/mono-abc123.woff2')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('never pins the documents that name the hashed assets', () => {
    // If any of these were cacheable, a deploy could leave a client on an old
    // shell forever — the whole reason the hashed assets can be immutable.
    expect(cachePolicy('/')).toBe('no-cache');
    expect(cachePolicy('/index.html')).toBe('no-cache');
    expect(cachePolicy('/sw.js')).toBe('no-cache');
    expect(cachePolicy('/manifest.webmanifest')).toBe('no-cache');
  });

  it('gives unhashed public/ files a short life, not an immutable one', () => {
    expect(cachePolicy('/favicon.svg')).toBe('public, max-age=3600');
  });
});

describe('if-none-match', () => {
  it('compares weakly and honours *', () => {
    expect(ifNoneMatchSatisfied('W/"a-b"', 'W/"a-b"')).toBe(true);
    expect(ifNoneMatchSatisfied('"a-b"', 'W/"a-b"')).toBe(true);
    expect(ifNoneMatchSatisfied('W/"x", W/"a-b"', 'W/"a-b"')).toBe(true);
    expect(ifNoneMatchSatisfied('*', 'W/"a-b"')).toBe(true);
    expect(ifNoneMatchSatisfied('W/"other"', 'W/"a-b"')).toBe(false);
    expect(ifNoneMatchSatisfied(undefined, 'W/"a-b"')).toBe(false);
  });
});

describe('serving', () => {
  it('serves the HTML shell no-cache, with a validator so reloads cost a 304', async () => {
    const res = await get('/');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    const again = await get('/', { 'if-none-match': etag as string });
    expect(again.status).toBe(304);
  });

  it('serves the brotli artifact when the client accepts it', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'br, gzip' });
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Number(res.headers.get('content-length'))).toBeLessThan(JS_BODY.length);
  });

  it('falls back to gzip, then identity', async () => {
    const gz = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    const raw = await get('/assets/index-abc123.js');
    expect(raw.headers.get('content-encoding')).toBeNull();
    expect(await raw.text()).toBe(JS_BODY);
  });

  it('304s a hashed asset the client already holds', async () => {
    const first = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' });
    const etag = first.headers.get('etag') as string;
    const res = await get('/assets/index-abc123.js', {
      'accept-encoding': 'br',
      'if-none-match': etag,
    });
    expect(res.status).toBe(304);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    expect(await res.text()).toBe('');
  });

  it('emits exactly one Vary on a negotiated response', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' });
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
  });

  it('refuses to cache a missing chunk — a client mid-deploy must retry', async () => {
    const res = await get('/assets/index-NOTBUILT.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // and it must NOT be the SPA shell, or the browser MIME-sniffs HTML as JS
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
  });

  it('serves the no-cache shell for SPA routes', async () => {
    const res = await get('/w/dev/t/muxpad');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('keeps /api and /ws 404s machine-readable', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('never lets a static path escape the web root', async () => {
    for (const path of ['/../package.json', '/assets/../../package.json', '/assets//..//x']) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
  });
});
