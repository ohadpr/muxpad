import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

/**
 * EVERY JSON GET GETS A VALIDATOR AND A COMPRESSOR.
 *
 * ─── What this was measured against ───────────────────────────────────────
 *
 * An IDLE muxpad page, 20 seconds, 537 tabs, nothing happening on screen:
 *
 *   GET /api/tabs?workspaceId=…   8 requests   1,988 KB
 *   GET /api/workspaces?all=1    34 requests      34 KB
 *   GET /api/browsers             5 requests      90 KB
 *   GET /api/tabs/:id/spawn-rounds 1 request      59 KB
 *
 * — about 2.2 MB of JSON per twenty seconds, forever, for a page that is just
 * sitting there. Over a tailnet from a phone that is the whole experience; on
 * a cold load it is also the critical path, because the browser allows six
 * connections to an origin and the boot requests queue behind the polls.
 *
 * Nearly all of it is BYTE-FOR-BYTE IDENTICAL to the answer the client already
 * holds: the polls exist to catch the rare edge (see workspaces.ts's own long
 * note on why they cannot simply be removed), and the rare edge is rare.
 *
 * So, two things, in this order:
 *
 *  1. AN ETAG, so an unchanged answer costs a 304 and no body. The browser
 *     does this on its own — `cache-control: no-cache` plus an `etag` makes
 *     `fetch` revalidate and hand the cached body back to the caller as a
 *     normal 200 — so NOTHING on the client changes. The request still happens
 *     (it is a poll; that is the point) but 250 KB becomes ~200 bytes.
 *  2. COMPRESSION of what actually did change. muxpad's JSON is names,
 *     timestamps and ULIDs: the 497 KB tab list gzips to about 60 KB.
 *
 * ─── Why it is a middleware and not a per-route concern ───────────────────
 *
 * Because the list of routes that are polled is not a list anyone maintains.
 * `/api/browsers` got a 2.5s poll from a card nobody was looking at; the next
 * one will arrive the same way. A validator that is a property of "a JSON GET"
 * cannot be forgotten by the next route.
 *
 * ─── What it deliberately leaves alone ────────────────────────────────────
 *
 * · Anything that is not a 200 JSON GET. An SSE stream (`/api/events`,
 *   text/event-stream) must never be buffered — hence the content-type gate
 *   rather than a path list.
 * · Responses that already carry a `content-encoding`.
 * · Anything already carrying an `etag` (static-assets.ts computes its own).
 * · Mutations. A POST answer is read once by the caller that caused it.
 */

/** Below this, compression costs more than it saves (and a 304 already covers
 *  the repeat case). Measured: a 900-byte answer gzips to ~500 and the header
 *  overhead eats the difference. */
export const MIN_COMPRESS_BYTES = 1024;

/**
 * Brotli quality. 4, not the default 11: at 500 KB, q11 is ~400ms of event
 * loop — on a server that also runs the agent panes — for about 8% over q4.
 * This is a poll response, not a static asset we compress once at build time.
 */
const BR_QUALITY = 4;

/**
 * The biggest answer this will hold in memory.
 *
 * muxpad's own JSON answers are hundreds of KB at the very top end (the tab
 * corpus on a 537-tab install is ~500 KB uncompressed). A `.json` ATTACHMENT
 * can be 512 MB. 2 MB is comfortably above everything the API produces and far
 * below anything that is really a file.
 */
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/** How many compressed bodies to remember, keyed by etag+encoding.
 *  A handful of hot endpoints × two encodings, with room to spare. */
const CACHE_MAX = 32;

export interface JsonCacheStats {
  /** Answers served as 304. */
  notModified: number;
  /** Answers compressed (fresh work). */
  compressed: number;
  /** Answers served from the compressed-body cache. */
  reused: number;
}

/**
 * What this client will accept, honouring the `q` values.
 *
 * `q=0` means NOT ACCEPTABLE, and sending an encoding a client has explicitly
 * refused hands it a body it cannot read (RFC 9110 §12.5.3). An earlier
 * version matched the token and ignored the weight, so
 * `Accept-Encoding: br;q=0, gzip` was answered in brotli.
 */
export function pickEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params
      .map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p))
      .find((m): m is RegExpExecArray => m !== null);
    weights.set(name.trim(), q ? Number.parseFloat(q[1] as string) : 1);
  }
  const acceptable = (name: string) => {
    const own = weights.get(name);
    if (own !== undefined) return own > 0;
    // A wildcard stands in for anything not named — including, at q=0, a
    // refusal of everything the client did not list.
    const star = weights.get('*');
    return star !== undefined && star > 0;
  };
  // br first: measurably smaller on this shape of JSON at a comparable cost.
  if (acceptable('br')) return 'br';
  if (acceptable('gzip')) return 'gzip';
  return null;
}

/** Weak validator: the body is semantically the same answer, byte-identical. */
export function etagOf(body: Uint8Array): string {
  return `W/"${createHash('sha1').update(body).digest('base64url')}"`;
}

/**
 * Does this `If-None-Match` name our etag?
 *
 * Split on commas because a browser may send the list it holds, and compare
 * leniently on the weak prefix: some intermediaries strip `W/`, and a
 * validator that fails to match because of two characters turns every 304 back
 * into a full body — the exact failure this middleware exists to remove, in a
 * form nobody would notice.
 */
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const bare = (s: string) => s.trim().replace(/^W\//, '');
  const want = bare(etag);
  return ifNoneMatch.split(',').some((candidate) => bare(candidate) === want);
}

/** A `Response` body from bytes. Node's Buffer/Uint8Array can be backed by a
 *  SharedArrayBuffer as far as the type system knows, which `BodyInit` will not
 *  accept; a copy into a plain ArrayBuffer-backed view is the honest fix and
 *  costs one memcpy of an already-small payload. */
function bodyOf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * THE ONE WAY TO REPLACE A RESPONSE IN HONO WITHOUT INHERITING ITS HEADERS.
 *
 * `set res(_res)` copies EVERY header off the previous response onto the
 * replacement (context.ts), with `.set()` — so it overwrites. The consequence
 * here was a malformed response: a route that declares its own
 * `content-length` (the attachments route streams a file and does) had that
 * length copied back over the COMPRESSED length, and a 304 got a body length
 * it had no body for. Reproduced: 42 bytes sent under `content-length: 2000`.
 *
 * Clearing first leaves nothing to copy from. It looks redundant and is not.
 */
function replaceResponse(c: Parameters<MiddlewareHandler>[0], res: Response): void {
  c.res = undefined;
  c.res = res;
}

/** Add one token to `Vary` without dropping what is already there. */
export function appendVary(headers: Headers, token: string): void {
  const existing = headers.get('vary');
  if (!existing) {
    headers.set('vary', token);
    return;
  }
  const have = existing
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (have.includes('*') || have.includes(token.toLowerCase())) return;
  headers.set('vary', `${existing}, ${token}`);
}

export function jsonCache(
  opts: { minCompressBytes?: number; maxBytes?: number; stats?: JsonCacheStats } = {},
): MiddlewareHandler {
  const minBytes = opts.minCompressBytes ?? MIN_COMPRESS_BYTES;
  const maxBytes = opts.maxBytes ?? MAX_BUFFER_BYTES;
  const compressed = new Map<string, Uint8Array>();

  return async (c, next) => {
    await next();
    // GET ONLY. HEAD used to be handled too, which meant reading and hashing a
    // whole file to answer a request whose entire point is that it has no
    // body. A HEAD now passes through untouched.
    if (c.req.method !== 'GET') return;
    const res = c.res;
    if (!res || res.status !== 200 || !res.body) return;
    if (res.headers.get('content-encoding')) return;
    if (res.headers.get('etag')) return;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json')) return;
    // ── NOT EVERY application/json IS AN API ANSWER ────────────────────────
    //
    // A `.json` ATTACHMENT is served from disk by the attachments route, as a
    // stream, with a declared length, and the upload ceiling is 512 MB. This
    // middleware would read all of it into memory, hash it, compress it
    // synchronously on the event loop the agent panes run on, and keep the
    // compressed copy. A declared length past the ceiling below is the signal
    // that this is a FILE rather than a value, and files go straight through.
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) return;

    // Buffering is safe HERE and nowhere else in this server: the gate above
    // has excluded streams, files, and anything that declares itself large.
    const body = new Uint8Array(await res.arrayBuffer());
    // …and a body that did NOT declare a length can still turn out to be one.
    // Hand it back unchanged rather than hold it.
    if (body.length > maxBytes) {
      replaceResponse(
        c,
        new Response(bodyOf(body), { status: 200, headers: new Headers(res.headers) }),
      );
      return;
    }
    const etag = etagOf(body);
    const headers = new Headers(res.headers);
    headers.set('etag', etag);
    // `no-cache` means "revalidate", NOT "don't store" — it is what makes the
    // browser send If-None-Match instead of either refetching blindly or
    // serving a stale body without asking. `no-store` here would delete the
    // entire benefit.
    headers.set('cache-control', 'no-cache');
    // APPENDED, not set: a route that varies on something else of its own
    // (`Vary: Cookie`) must keep saying so, or a cache keyed on the wrong
    // thing will serve one client another's answer.
    appendVary(headers, 'accept-encoding');

    if (matchesEtag(c.req.header('if-none-match'), etag)) {
      if (opts.stats) opts.stats.notModified++;
      // A 304 carries validators and no body. Content-Length must go with the
      // body: a 304 claiming 497 KB of content hangs a strict client.
      headers.delete('content-length');
      replaceResponse(c, new Response(null, { status: 304, headers }));
      return;
    }

    const encoding = body.length >= minBytes ? pickEncoding(c.req.header('accept-encoding')) : null;
    if (!encoding) {
      replaceResponse(c, new Response(bodyOf(body), { status: 200, headers }));
      return;
    }

    const key = `${etag}:${encoding}`;
    let out: Uint8Array | undefined = compressed.get(key);
    if (out) {
      if (opts.stats) opts.stats.reused++;
    } else {
      out =
        encoding === 'br'
          ? brotliCompressSync(body, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: BR_QUALITY,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
              },
            })
          : gzipSync(body, { level: 6 });
      if (opts.stats) opts.stats.compressed++;
      // Keyed by etag, so an answer that changes evicts itself by never being
      // asked for again; the cap is what bounds a server that has been up for
      // weeks. Oldest-first, which for this access pattern is the same thing
      // as least-recently-useful.
      if (compressed.size >= CACHE_MAX) {
        const oldest = compressed.keys().next().value;
        if (oldest !== undefined) compressed.delete(oldest);
      }
      compressed.set(key, out);
    }

    headers.set('content-encoding', encoding);
    headers.set('content-length', String(out.length));
    replaceResponse(c, new Response(bodyOf(out), { status: 200, headers }));
  };
}
