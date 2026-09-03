import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, Hono } from 'hono';

/**
 * Serving the built web bundle.
 *
 * Three concerns, in the order a request meets them:
 *
 *  1. CACHING. The HTML shell is `no-cache` (always revalidated) and every
 *     content-hashed asset is `immutable` for a year. That split is the whole
 *     invalidation story: the shell is the only mutable document, and it names
 *     the hashed assets it needs, so a deploy can never leave a client pairing
 *     a fresh shell with a stale chunk. Anything cached `immutable` MUST have a
 *     content-derived name — that is why the webfonts moved out of `public/`
 *     (verbatim copy, stable name) into `src/` (Vite hashes them).
 *
 *  2. VALIDATORS. Everything gets a weak ETag + Last-Modified, so the paths we
 *     deliberately keep revalidating (the shell, `sw.js`, the manifest) cost a
 *     304 rather than a full re-download on every load.
 *
 *  3. COMPRESSION. `precompressed: true` makes serveStatic prefer the `.br`
 *     (then `.gz`) sibling emitted at build time — see the precompress plugin
 *     in web/vite.config.ts. The main bundle goes 1,111,714 → 269,619 bytes.
 */

/** Where Vite writes its content-hashed output. */
const HASHED_PREFIX = '/assets/';

/**
 * A Vite content hash as the final dash-delimited segment of the name:
 * `index-Cgp7p3nE.js`, `MesloLGS-NF-Bold-LSOmEg34.woff2`.
 *
 * The /assets/ PREFIX alone is not enough to justify `immutable`, even though
 * everything Vite emits there today is hashed. `web/public/**` is copied into
 * the same dist root verbatim, so the day someone adds
 * `web/public/assets/logo.svg`, that stable name — one a deploy CAN change in
 * place — would inherit a year-long pin. That is precisely the trap rule (1)
 * above exists to avoid, and it is unrecoverable without the user clearing
 * site data. Requiring the hash to be visible in the NAME makes the rule
 * self-enforcing.
 *
 * Exactly 8 base64url chars (Vite's default) plus at least one digit or
 * capital, which is what separates a hash from a word like `logo-unhashed`.
 * Every way this can be wrong is the SAFE way: an unrecognised name falls
 * back to SHORT_MAX_AGE — a revalidation per hour, not a permanent pin. (So
 * if someone reconfigures the hash length, assets get slower, never stale.)
 */
const CONTENT_HASHED = /-(?=[A-Za-z0-9_]*[A-Z0-9])[A-Za-z0-9_]{8}\.[A-Za-z0-9]+$/;

/**
 * Paths that must never be pinned. The shell obviously; `sw.js` because a
 * stale service worker is unrecoverable-ish (browsers bypass the HTTP cache
 * for the SW script on update checks, but only some of them, and only
 * sometimes); the manifest because it names the icons and the start URL.
 */
const ALWAYS_REVALIDATE = new Set(['/', '/index.html', '/sw.js', '/manifest.webmanifest']);

/**
 * Unhashed odds and ends in `public/` (favicons, the touch icon). An hour of
 * freshness then a cheap 304 — they change about once a year, and pinning an
 * unhashed name is exactly the trap rule (1) exists to avoid.
 */
const SHORT_MAX_AGE = 'public, max-age=3600';
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function cachePolicy(path: string): string {
  if (ALWAYS_REVALIDATE.has(path)) return 'no-cache';
  if (path.startsWith(HASHED_PREFIX) && CONTENT_HASHED.test(path)) return IMMUTABLE;
  return SHORT_MAX_AGE;
}

/**
 * Weak validator over (size, mtime). Weak is the correct strength here: the
 * same URL is served as identity or brotli depending on Accept-Encoding, and a
 * strong ETag asserts byte-for-byte equality of the *encoded* representation,
 * which those two are not. Weak only asserts semantic equivalence — exactly
 * what a revalidation needs.
 */
function validators(fsPath: string): { etag: string; lastModified: string } | null {
  try {
    const s = statSync(fsPath);
    if (!s.isFile()) return null;
    return {
      etag: `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`,
      lastModified: new Date(s.mtime).toUTCString(),
    };
  } catch {
    return null;
  }
}

/** Reject anything that could escape the web root before it reaches the fs. */
function safeRelPath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (/(?:^|[/\\])\.{1,2}(?:$|[/\\])|[/\\]{2,}/.test(decoded)) return null;
  return decoded.slice(1);
}

/** Does the client's If-None-Match cover `etag`? (Weak comparison.) */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === bare);
}

/**
 * Mount the built web bundle (`webRoot`) onto `app`: cache headers +
 * conditional requests, precompressed static files, and the SPA fallback.
 */
export function mountStaticWeb(app: Hono, webRoot: string): void {
  // The HTML shell. Read fresh on every request: caching it in memory means a
  // rebuild that produces a new hashed bundle name still serves the old HTML,
  // which then 404s on its asset references. The file is ~1KB.
  const serveIndexHtml = (c: Context) => {
    const file = join(webRoot, 'index.html');
    const v = validators(file);
    c.header('Cache-Control', 'no-cache');
    if (v) {
      c.header('ETag', v.etag);
      c.header('Last-Modified', v.lastModified);
      if (ifNoneMatchSatisfied(c.req.header('if-none-match'), v.etag)) return c.body(null, 304);
    }
    try {
      return c.html(readFileSync(file, 'utf-8'));
    } catch {
      return c.text('not found', 404);
    }
  };
  app.get('/', serveIndexHtml);
  // Direct /index.html requests must not slip through to serveStatic either —
  // that would hand the shell back without the no-cache header, the exact trap
  // this route exists to close.
  app.get('/index.html', serveIndexHtml);

  // Cache headers + conditional requests for everything serveStatic will hand
  // out. This runs BEFORE serveStatic so a 304 short-circuits without opening
  // the file, and — importantly — it only attaches headers when the file
  // actually exists. Setting them unconditionally would leak `immutable` onto
  // the 404 that a missing chunk produces, poisoning a client that raced a
  // deploy: it would then cache "this chunk does not exist" for a year.
  app.use('/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const rel = safeRelPath(c.req.path);
    if (rel === null) return next();
    const v = validators(join(webRoot, rel));
    if (!v) return next();
    c.header('Cache-Control', cachePolicy(c.req.path));
    c.header('ETag', v.etag);
    c.header('Last-Modified', v.lastModified);
    if (ifNoneMatchSatisfied(c.req.header('if-none-match'), v.etag)) {
      // Only on the 304: serveStatic appends its own `Vary: Accept-Encoding`
      // whenever it actually negotiates an encoding, and this path skips it.
      c.header('Vary', 'Accept-Encoding');
      return c.body(null, 304);
    }
    return next();
  });

  app.use('/*', serveStatic({ root: webRoot, precompressed: true }));

  // Anything that fell through both API routes and static files lands here.
  // API/WS paths return JSON 404 so the client can parse them; everything else
  // is treated as a client-side SPA route and gets index.html.
  //
  // Asset paths (/assets/*) and any path with a file extension must NEVER fall
  // back to index.html — serving HTML with a JS or CSS Content-Type triggers
  // the browser's MIME-type sniffing and breaks module loading. Those return
  // a real 404 instead.
  app.notFound((c) => {
    const path = c.req.path;
    if (path.startsWith('/api/') || path.startsWith('/ws/')) {
      return c.json({ error: { code: 'not_found', message: 'route not found' } }, 404);
    }
    if (path.startsWith(HASHED_PREFIX) || /\.[a-zA-Z0-9]+$/.test(path)) {
      // A missing hashed chunk is the signature of a client that raced a
      // deploy. Make absolutely sure this answer is never cached.
      c.header('Cache-Control', 'no-store');
      return c.text('not found', 404);
    }
    // SPA client route (e.g. /w/:ws/t/:tab) → the no-cache HTML shell.
    return serveIndexHtml(c);
  });
}
