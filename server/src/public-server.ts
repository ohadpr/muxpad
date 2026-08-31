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
 * - Every response is SANDBOXED into its own opaque origin — see SANDBOX.
 */

/**
 * `Content-Security-Policy: sandbox …` on EVERY response.
 *
 * WHY: every artifact ever published, plus every `@2`/`@3` rotation of each,
 * shares ONE public origin — and the MIME map happily serves html, js and
 * svg. Without this, `/report/` and `/other-report/` are same-origin: one
 * agent-generated page's inline script can read the other's localStorage,
 * IndexedDB and cookies, and a NAVIGATED `.svg` executes script in that same
 * shared origin. Nothing on this port is authenticated, but "agent-written
 * HTML" is exactly the class of content you do not want holding a stable
 * origin in common with the next thing an agent writes.
 *
 * `sandbox` forces each document into a fresh OPAQUE origin, so there is no
 * shared storage bucket to read — the isolation is structural, not a rule a
 * page could talk its way around.
 *
 * WHY NOT BARE `sandbox`: with no tokens it also kills scripts, and published
 * artifacts here are dashboards, charts and reports whose whole point is the
 * inline script. Bare `sandbox` renders them as dead layout — the bytes still
 * arrive, the page just sits there. So this is the strictest token set that
 * still renders them. `allow-scripts` and the opaque origin are verified in a
 * REAL browser (integration/public-csp.test.ts, which goes red on a bare
 * `sandbox`); the exact token LIST is pinned by public-server.test.ts.
 *
 *   allow-scripts   inline <script> is what an artifact IS. Deliberately WITHOUT
 *                   allow-same-origin — that pair together would hand the page
 *                   the real origin back and undo the entire point.
 *   allow-forms     filter/search boxes in report pages.
 *   allow-modals    alert/confirm/print.
 *   allow-popups    target="_blank" links out to sources.
 *   allow-popups-to-escape-sandbox
 *                   …and those sources must then work NORMALLY. Without it a
 *                   popup inherits this sandbox, so a linked-to site opens
 *                   with an opaque origin and throws on its own storage. Not
 *                   a hole: a popup pointed back at THIS server gets this
 *                   header on its own response and is sandboxed again, and an
 *                   `about:blank` popup inherits the opener's opaque origin.
 *
 *   allow-downloads "export CSV" buttons.
 *
 * NOT `allow-top-navigation-by-user-activation`, though multi-page artifacts
 * (relative <a href> between pages) are the norm: measured, a sandboxed
 * document may always navigate ITSELF, so ordinary links work without it. In
 * the framed case (an artifact in a muxpad URL pane) the effective sandbox is
 * the UNION of this header and the iframe's own `sandbox=` attribute, and
 * UrlPane.tsx does not grant top-navigation either — so the token would be
 * inert there too. It buys nothing, so it is not granted.
 *
 * Opaque-origin fallout, and why it is acceptable: `localStorage` access
 * THROWS and the artifact's own `fetch('./data.json')` becomes cross-origin.
 * No artifact under `<dataDir>/public/` uses either today, and the fetch case
 * is restored by the `access-control-allow-origin` below.
 *
 * NO `frame-ancestors`/`X-Frame-Options`, on purpose: there is no login, no
 * cookie and no privileged action on this origin, so framing steals nothing —
 * while blocking it would break the ordinary "publish it, then open the link
 * in a muxpad URL pane" loop, which is an iframe.
 */
const SANDBOX =
  'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';

/**
 * `null`, not `*`.
 *
 * The sandbox above gives every document here an opaque origin, which makes an
 * artifact's own `fetch('./data.json')` a CROSS-origin request — a data-driven
 * dashboard would render empty with a 200 in the network tab. Allowing the
 * opaque origin back is what keeps that pattern working.
 *
 * `null` is the origin our own sandboxed documents send, and nothing else
 * routinely does — so ordinary pages on named origins are not handed blanket
 * read access. That matters because the public port is NOT always public:
 * `MUXPAD_NO_FUNNEL=1` (and the 127.0.0.1 default bind) leaves it reachable
 * only from the machine, where a page in the user's own browser could
 * otherwise read a private artifact by guessing its slug. Honest limit: any
 * page can obtain a null origin by sandboxing itself, so this is a narrowing,
 * not a boundary — the boundary is that slugs are unguessable.
 */
const ARTIFACT_ACAO = 'null';

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

  // Every response leaves with the sandbox, including 404s and the
  // trailing-slash redirect — one place, so no future branch can forget it.
  const guard: Record<string, string> = {
    'content-security-policy': SANDBOX,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
  app.use('*', async (c, next) => {
    // BEFORE: these land in Hono's prepared headers, so a response Hono builds
    // itself — including the 500 from an unexpected throw below — carries them.
    for (const [k, v] of Object.entries(guard)) c.header(k, v);
    await next();
    // AFTER: the file handler returns a raw `new Response(stream, …)`, which
    // bypasses prepared headers entirely. Setting them again writes onto that
    // response. Both halves are needed; neither alone covers every path.
    for (const [k, v] of Object.entries(guard)) c.header(k, v);
  });

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
      // Lets an artifact fetch its own sibling data file from the opaque
      // origin the sandbox puts it in. See ARTIFACT_ACAO for why `null`.
      'access-control-allow-origin': ARTIFACT_ACAO,
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
