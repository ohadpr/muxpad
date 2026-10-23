import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type JsonCacheStats,
  MIN_COMPRESS_BYTES,
  appendVary,
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

/**
 * WHAT THE REVIEW FOUND — each case is the reproduction, kept.
 *
 * Every one of these passed review as "the comment says it is handled". They
 * were not, and three of them produce a MALFORMED response rather than a slow
 * one, which is the failure a middleware under `/api/*` must never have.
 */
describe('replacing a response in Hono', () => {
  it('does not inherit the handler’s own content-length', async () => {
    // `set res()` copies every header off the previous response with .set(),
    // so the ORIGINAL length landed on the COMPRESSED body. Reproduced in
    // review as 42 bytes sent under `content-length: 2000`.
    const a = new Hono();
    a.use('*', jsonCache());
    a.get('/file', (c) =>
      c.body(JSON.stringify(BIG), 200, {
        'content-type': 'application/json',
        'content-length': String(JSON.stringify(BIG).length),
      }),
    );
    const res = await get(a, '/file', { 'accept-encoding': 'gzip' });
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
    expect(JSON.parse(gunzipSync(bytes).toString('utf8'))).toEqual(BIG);
  });

  it('does not put a body length on a 304', async () => {
    const a = new Hono();
    a.use('*', jsonCache());
    a.get('/file', (c) =>
      c.body(JSON.stringify(BIG), 200, {
        'content-type': 'application/json',
        'content-length': String(JSON.stringify(BIG).length),
      }),
    );
    const etag = (await get(a, '/file')).headers.get('etag') ?? '';
    const again = await get(a, '/file', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('content-length')).toBeNull();
  });

  it('KEEPS a route’s own Vary and adds its own', async () => {
    // Overwriting `Vary: Cookie` would let a shared cache serve one client
    // another's answer.
    const a = new Hono();
    a.use('*', jsonCache());
    a.get('/varies', (c) => c.json(BIG, 200, { vary: 'Cookie' }));
    const res = await get(a, '/varies', { 'accept-encoding': 'gzip' });
    const vary = (res.headers.get('vary') ?? '').toLowerCase();
    expect(vary).toContain('cookie');
    expect(vary).toContain('accept-encoding');
  });
});

describe('what it refuses to hold', () => {
  const bigFile = (bytes: number) => {
    const a = new Hono();
    a.use('*', jsonCache({ maxBytes: 1024 }));
    a.get('/attachment.json', (c) =>
      c.body('x'.repeat(bytes), 200, {
        'content-type': 'application/json',
        'content-length': String(bytes),
      }),
    );
    return a;
  };

  it('passes a DECLARED large file straight through, unread', async () => {
    // A `.json` attachment is served from disk with a declared length and the
    // upload ceiling is 512 MB. Buffering, hashing and compressing one is the
    // event loop the agent panes run on.
    const res = await get(bigFile(4096), '/attachment.json', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
    expect((await res.text()).length).toBe(4096);
  });

  it('still hands back a body that turned out large without saying so', async () => {
    const a = new Hono();
    a.use('*', jsonCache({ maxBytes: 1024 }));
    a.get('/undeclared', (c) =>
      c.body('y'.repeat(4096), 200, { 'content-type': 'application/json' }),
    );
    const res = await get(a, '/undeclared', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect((await res.text()).length).toBe(4096);
  });

  it('leaves HEAD alone — reading a whole file to answer "no body" is absurd', async () => {
    const a = app();
    const res = await a.fetch(new Request('http://local/big', { method: 'HEAD' }));
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
  });
});

describe('Accept-Encoding weights', () => {
  it('NEVER sends an encoding the client refused with q=0', async () => {
    const res = await get(app(), '/big', { 'accept-encoding': 'br;q=0, gzip;q=1' });
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('refuses everything when every candidate is q=0', async () => {
    const res = await get(app(), '/big', { 'accept-encoding': 'br;q=0, gzip;q=0' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual(BIG);
  });

  it('honours a wildcard, and a wildcard refusal', async () => {
    expect(
      (await get(app(), '/big', { 'accept-encoding': '*' })).headers.get('content-encoding'),
    ).toBe('br');
    expect(
      (await get(app(), '/big', { 'accept-encoding': '*;q=0' })).headers.get('content-encoding'),
    ).toBeNull();
  });
});

describe('appendVary', () => {
  it('adds, dedupes, and respects a wildcard', () => {
    const h = new Headers();
    appendVary(h, 'accept-encoding');
    expect(h.get('vary')).toBe('accept-encoding');
    appendVary(h, 'accept-encoding');
    expect(h.get('vary')).toBe('accept-encoding');
    const w = new Headers({ vary: '*' });
    appendVary(w, 'accept-encoding');
    expect(w.get('vary')).toBe('*');
  });
});
