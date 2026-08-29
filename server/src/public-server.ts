import { createReadStream, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';

/**
 * The PUBLIC static server (docs/plans/2026-08-28-muxpad-publish.md §1).
 *
 * This app is bound to its own port (default :7778) and — via Tailscale
 * Funnel — the open internet. It therefore serves NOTHING except static
 * files under `<dataDir>/public/`: no API routes, no WS, no directory
 * listings, no SPA fallback. The main :7777 app (tailnet, unauthenticated)
 * must NEVER be mounted here or funneled.
 *
 * Security posture:
 * - Path segments are decoded individually; any segment that decodes to
 *   `.`/`..` or contains a separator/NUL is a 404. (Literal `../` never even
 *   reaches us — WHATWG URL parsing collapses dot-segments at the root.)
 * - Symlink policy: the fully-resolved (realpath) target must stay inside
 *   the public dir, else 404. Publish copies content with dereference:true
 *   so legitimate artifacts are always regular files; a symlink that points
 *   outside the tree is treated as hostile, never followed.
 * - No request-derived bytes ever reach a response header: Content-Type
 *   comes from a fixed extension map, and the only reflected value (the
 *   trailing-slash redirect Location) is the still-percent-encoded pathname,
 *   which cannot contain raw CR/LF.
 */

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  zip: 'application/zip',
};

function contentType(name: string): string {
  const i = name.lastIndexOf('.');
  const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

export function createPublicApp(publicDir: string): Hono {
  const app = new Hono();

  app.on(['GET', 'HEAD'], '/*', (c) => {
    const notFound = () => c.text('not found', 404);
    const rawPath = new URL(c.req.url).pathname; // percent-encoded, dot-segments collapsed
    // The root serves nothing — no index, no listing. Content lives only
    // under slugs, and knowing the hostname alone should reveal nothing.
    if (rawPath === '/') return notFound();

    const segs: string[] = [];
    for (const seg of rawPath.split('/')) {
      if (seg === '') continue; // leading/trailing/double slashes
      let dec: string;
      try {
        dec = decodeURIComponent(seg);
      } catch {
        return notFound();
      }
      if (dec === '.' || dec === '..' || /[/\\\0]/.test(dec)) return notFound();
      segs.push(dec);
    }
    if (segs.length === 0) return notFound();

    let filePath = join(publicDir, ...segs);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(filePath);
    } catch {
      return notFound();
    }
    if (st.isDirectory()) {
      // Canonicalize `/slug` → `/slug/` so relative asset links resolve,
      // then serve the directory's index.html. No listings — a directory
      // without an index is a 404 by design. Location is REBUILT from the
      // validated segments — echoing rawPath could emit a scheme-relative
      // `//host` Location.
      if (!rawPath.endsWith('/'))
        return c.redirect(`/${segs.map(encodeURIComponent).join('/')}/`, 301);
      filePath = join(filePath, 'index.html');
      try {
        st = statSync(filePath);
      } catch {
        return notFound();
      }
    }
    if (!st.isFile()) return notFound();

    // Symlink containment: whatever this path ultimately resolves to must
    // live under the (resolved) public dir. realpath both sides — on macOS
    // the data dir itself often sits behind /var → /private/var.
    try {
      const real = realpathSync(filePath);
      const root = realpathSync(publicDir);
      if (real !== root && !real.startsWith(root + sep)) return notFound();
    } catch {
      return notFound();
    }

    const type = contentType(filePath);
    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(st.size),
      'x-content-type-options': 'nosniff',
      // HTML revalidates quickly so republishing a named slug propagates;
      // assets cache for a day. Random slugs are effectively immutable, but
      // a named slug can be overwritten in place, so no `immutable` on HTML.
      'cache-control': type.startsWith('text/html')
        ? 'public, max-age=60, must-revalidate'
        : 'public, max-age=86400',
    };
    if (c.req.method === 'HEAD') return new Response(null, { headers });
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { headers });
  });

  // Anything not GET/HEAD (and any residual route) is a 404 — there is no
  // API surface on this port, by construction.
  app.notFound((c) => c.text('not found', 404));
  return app;
}
