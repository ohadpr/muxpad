import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type JsonCacheStats,
  MIN_COMPRESS_BYTES,
  etagOf,
  jsonCache,
  matchesEtag,
  pickEncoding,
} from './json-cache.js';

/**
 * The thing to keep true: a poll that learns nothing must cost nothing, and
 * nothing a client reads may change shape because of it.
 */

const BIG = { rows: Array.from({ length: 400 }, (_, i) => ({ id: `01M${i}`, name: `tab ${i}` })) };

function app(stats?: JsonCacheStats) {
  const a = new Hono();
  a.use('*', jsonCache(stats ? { stats } : {}));
  a.get('/big', (c) => c.json(BIG));
  a.get('/small', (c) => c.json({ ok: true }));
  a.get('/stream', (c) =>
    c.body(new ReadableStream(), 200, { 'content-type': 'text/event-stream' }),
  );
  a.get('/png', (c) => c.body(new Uint8Array(4096), 200, { 'content-type': 'image/png' }));
  a.get('/own-etag', (c) => c.json(BIG, 200, { etag: 'W/"mine"' }));
  a.post('/write', (c) => c.json(BIG));
  a.get('/404', (c) => c.json({ error: 'nope' }, 404));
  return a;
}

const get = (a: Hono, path: string, headers: Record<string, string> = {}) =>
  a.fetch(new Request(`http://local${path}`, { headers }));

describe('revalidation', () => {
  it('answers 304 with NO body when the client already holds this answer', async () => {
    const a = app();
    const first = await get(a, '/big');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^W\/"/);

    const second = await get(a, '/big', { 'if-none-match': etag });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    // A 304 claiming the body's length hangs a strict client.
    expect(second.headers.get('content-length')).toBeNull();
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('tells the browser to REVALIDATE, not to skip asking', async () => {
    // `no-store` here would delete the whole benefit: the browser would refetch
    // in full every time instead of sending If-None-Match.
    const res = await get(app(), '/big');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('vary')).toBe('accept-encoding');
  });

  it('sends the full answer again once it has changed', async () => {
    const a = new Hono();
    let n = 0;
    a.use('*', jsonCache());
    a.get('/counter', (c) => c.json({ n: n++ }));
    const first = await get(a, '/counter');
    const stale = first.headers.get('etag') ?? '';
    const second = await get(a, '/counter', { 'if-none-match': stale });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ n: 1 });
  });

  it('matches an etag whose weak prefix an intermediary stripped', async () => {
    const a = app();
    const etag = (await get(a, '/big')).headers.get('etag') ?? '';
    const bare = etag.replace(/^W\//, '');
    expect((await get(a, '/big', { 'if-none-match': bare })).status).toBe(304);
  });

  it('matches one etag out of a list the client offers', async () => {
    const a = app();
    const etag = (await get(a, '/big')).headers.get('etag') ?? '';
    const res = await get(a, '/big', { 'if-none-match': `W/"other", ${etag}` });
    expect(res.status).toBe(304);
  });
});

describe('compression', () => {
  it('gzips a big answer and the bytes still parse as the same JSON', async () => {
    const res = await get(app(), '/big', { 'accept-encoding': 'gzip' });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const raw = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(gunzipSync(raw).toString('utf8'))).toEqual(BIG);
    // The whole point: an order of magnitude, not a few percent.
    expect(raw.length).toBeLessThan(JSON.stringify(BIG).length / 4);
  });

  it('prefers brotli when the client takes it', async () => {
    const res = await get(app(), '/big', { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.headers.get('content-encoding')).toBe('br');
    const raw = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(brotliDecompressSync(raw).toString('utf8'))).toEqual(BIG);
  });

  it('leaves a small answer alone', async () => {
    const res = await get(app(), '/small', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('sends plain bytes to a client that asked for no encoding', async () => {
    const res = await get(app(), '/big');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual(BIG);
  });

  it('reuses a compressed body rather than compressing the same answer twice', async () => {
    const stats: JsonCacheStats = { notModified: 0, compressed: 0, reused: 0 };
    const a = app(stats);
    await get(a, '/big', { 'accept-encoding': 'gzip' });
    await get(a, '/big', { 'accept-encoding': 'gzip' });
    expect(stats.compressed).toBe(1);
    expect(stats.reused).toBe(1);
  });

  it('declares the compressed length, not the original', async () => {
    const res = await get(app(), '/big', { 'accept-encoding': 'gzip' });
    const raw = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(raw.length);
  });
});

describe('what it must not touch', () => {
  it('NEVER buffers a stream — an SSE feed has no last byte', async () => {
    const res = await get(app(), '/stream', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
    expect(res.body).not.toBeNull();
  });

  it('leaves non-JSON alone', async () => {
    const res = await get(app(), '/png', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
  });

  it('leaves a route that computes its own validator alone', async () => {
    const res = await get(app(), '/own-etag', { 'accept-encoding': 'br' });
    expect(res.headers.get('etag')).toBe('W/"mine"');
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('leaves mutations alone — a POST answer is read once', async () => {
    const res = await app().fetch(
      new Request('http://local/write', { method: 'POST', headers: { 'accept-encoding': 'br' } }),
    );
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('leaves an error alone — a 404 is not a cacheable answer', async () => {
    const res = await get(app(), '/404', { 'accept-encoding': 'br' });
    expect(res.status).toBe(404);
    expect(res.headers.get('etag')).toBeNull();
  });
});

describe('helpers', () => {
  it('pickEncoding reads a real Accept-Encoding header', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip, deflate')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
    // Not fooled by a token that merely CONTAINS one of the names.
    expect(pickEncoding('brotli-ish')).toBeNull();
  });

  it('etagOf is stable for the same bytes and different for others', () => {
    const a = etagOf(new TextEncoder().encode('{"a":1}'));
    expect(etagOf(new TextEncoder().encode('{"a":1}'))).toBe(a);
    expect(etagOf(new TextEncoder().encode('{"a":2}'))).not.toBe(a);
  });

  it('matchesEtag ignores a missing header and honours *', () => {
    expect(matchesEtag(undefined, 'W/"x"')).toBe(false);
    expect(matchesEtag('*', 'W/"x"')).toBe(true);
  });

  it('MIN_COMPRESS_BYTES is a real threshold, not zero', () => {
    expect(MIN_COMPRESS_BYTES).toBeGreaterThan(0);
  });
});
