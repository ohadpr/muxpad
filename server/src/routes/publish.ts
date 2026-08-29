import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { Funnel } from '../funnel.js';
import { GlobalsStore } from '../store/GlobalsStore.js';

/**
 * Publish API (docs/plans/2026-08-28-muxpad-publish.md §2) — mounted on the
 * MAIN (tailnet) port; the published bytes are served by the separate public
 * static app (public-server.ts).
 *
 *   POST   /api/publish { path, name?, public_base_url? }
 *          → { slug, url, files, bytes, warning? }
 *   GET    /api/publish → { publishes: [{ slug, files, bytes, created }] }
 *   DELETE /api/publish/:slug
 *
 * No DB rows for the publishes themselves: a publish is fully described by
 * its slug directory on disk (created = dir birthtime), so the filesystem IS
 * the record — nothing to migrate, nothing to drift when a dir is removed by
 * hand.
 *
 * URL resolution — three-tier, because the live server runs under launchd
 * where the macOS Tailscale app CLI refuses to run ("The Tailscale GUI
 * failed to start", CLIError 3); it only works from user shells:
 *   1. a `public_base_url` hint in the POST body (the CLI discovers it in
 *      the pane shell where tailscale DOES work) — validated, persisted;
 *   2. fresh server-side CLI discovery (funnel.ensure()) — works in dev /
 *      non-launchd runs; persisted on success;
 *   3. the persisted `public_base_url` key in the globals KV — seeded by
 *      either of the above, so headless/cron publishes keep working;
 *   4. else the local URL + a warning.
 *
 * Source paths must be absolute; any path the server can read is fair game
 * (personal tool). The one refusal is publishing the public dir into itself
 * (or an ancestor of it), which would recurse forever.
 */

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/** globals-KV key holding the last known public base url (no trailing /). */
export const PUBLIC_BASE_URL_KEY = 'public_base_url';

/**
 * Validate + normalize a client-supplied base-url hint. Only well-formed
 * https origins (optionally with a port) are accepted — no path, query,
 * hash, or credentials — and the trailing slash is dropped so callers can
 * append `/<slug>/` uniformly. Returns null on anything else.
 */
export function normalizeBaseUrl(hint: unknown): string | null {
  if (typeof hint !== 'string' || hint.length === 0 || hint.length > 512) return null;
  let url: URL;
  try {
    url = new URL(hint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

function publicDirOf(dataDir: string): string {
  return join(dataDir, 'public');
}

/**
 * Recursive copy that fully dereferences symlinks so the public tree holds
 * ONLY regular files — the static server's symlink-containment check then
 * never trips on legitimate content. (node's cpSync `dereference` does not
 * dereference NESTED symlinks, hence hand-rolled.) Broken links and
 * non-regular files (sockets, fifos) are skipped; a symlink loop eventually
 * errors out of statSync and is skipped the same way.
 */
const MAX_COPY_DEPTH = 32;

function copyDereferenced(src: string, dest: string, forbidden: string, depth = 0): void {
  if (depth > MAX_COPY_DEPTH) return; // symlink-cycle / pathological nesting cap
  let st: ReturnType<typeof statSync>;
  let real: string;
  try {
    st = statSync(src); // follows symlinks
    real = realpathSync(src);
  } catch {
    return; // broken symlink / vanished mid-copy — skip
  }
  // A NESTED symlink can point at the public dir itself (or an ancestor of
  // it, like $HOME or /): copying would re-enter our own output for an
  // unbounded blow-up and mirror sensitive trees to the internet. The
  // top-level guard in the route can't see nested links — enforce here too.
  if (real === forbidden || forbidden.startsWith(real.endsWith(sep) ? real : real + sep)) return;
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src))
      copyDereferenced(join(src, name), join(dest, name), forbidden, depth + 1);
  } else if (st.isFile()) {
    copyFileSync(src, dest);
  }
}

function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    files += 1;
    bytes += statSync(join(e.parentPath, e.name)).size;
  }
  return { files, bytes };
}

export function publishRoutes(deps: {
  db: Database.Database;
  dataDir: string;
  funnel: Funnel;
}): Hono {
  const app = new Hono();
  const globals = new GlobalsStore(deps.db);

  /** The tiered base-url resolution described in the module doc. */
  async function resolveBaseUrl(hint: unknown): Promise<{ baseUrl: string; warning?: string }> {
    if (hint !== undefined) {
      // Callers only send hints they discovered themselves; validation
      // happened (400) before any copying, so this cannot be null here.
      const base = normalizeBaseUrl(hint) as string;
      globals.set(PUBLIC_BASE_URL_KEY, base);
      return { baseUrl: base };
    }
    const discovered = await deps.funnel.ensure();
    if (!discovered.warning) {
      globals.set(PUBLIC_BASE_URL_KEY, discovered.baseUrl);
      return discovered;
    }
    const saved = globals.get(PUBLIC_BASE_URL_KEY);
    // A persisted base is a KNOWN-public URL — no warning when we use it.
    if (saved) return { baseUrl: saved };
    return discovered; // local URL + warning
  }

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      path?: unknown;
      name?: unknown;
      public_base_url?: unknown;
    } | null;
    const src = typeof body?.path === 'string' ? body.path : '';
    if (!src || !isAbsolute(src))
      return c.json({ error: { code: 'bad_request', message: 'path must be absolute' } }, 400);
    const name = body?.name;
    if (name !== undefined && (typeof name !== 'string' || !SLUG_RE.test(name)))
      return c.json(
        { error: { code: 'bad_request', message: 'name must match [a-z0-9-]{1,64}' } },
        400,
      );
    const hint = body?.public_base_url;
    if (hint !== undefined && normalizeBaseUrl(hint) === null)
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: 'public_base_url must be a well-formed https origin',
          },
        },
        400,
      );

    const srcPath = resolve(src);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(srcPath);
    } catch {
      return c.json({ error: { code: 'not_found', message: `no such path: ${srcPath}` } }, 404);
    }
    if (!st.isFile() && !st.isDirectory())
      return c.json(
        { error: { code: 'bad_request', message: 'path is not a file or directory' } },
        400,
      );

    const publicDir = publicDirOf(deps.dataDir);
    mkdirSync(publicDir, { recursive: true });
    // Publishing the public dir (or an ancestor like the data dir) would
    // copy the destination into itself, recursively.
    const realSrc = realpathSync(srcPath);
    const realPub = realpathSync(publicDir);
    // NB: realSrc may be '/' (or another sep-terminated root); naive
    // `realSrc + sep` would be '//' and never match, letting `publish /`
    // copy the whole filesystem into the publicly served dir.
    const srcPrefix = realSrc.endsWith(sep) ? realSrc : realSrc + sep;
    if (realSrc === realPub || realSrc.startsWith(realPub + sep) || realPub.startsWith(srcPrefix))
      return c.json(
        {
          error: { code: 'bad_request', message: 'refusing to publish the public dir into itself' },
        },
        400,
      );

    // Named slug: republish-in-place semantics (overwrite). Random slug:
    // 8 hex chars of crypto randomness, retried on the ~impossible collision.
    let slug = typeof name === 'string' ? name : '';
    if (!slug) {
      do {
        slug = randomBytes(4).toString('hex');
      } while (existsSync(join(publicDir, slug)));
    }
    const dest = join(publicDir, slug);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest);
    if (st.isDirectory()) {
      copyDereferenced(srcPath, dest, realPub);
    } else {
      // A lone HTML file becomes the slug's index so the URL is just /<slug>/.
      const fname = /\.html?$/i.test(srcPath) ? 'index.html' : basename(srcPath);
      copyFileSync(srcPath, join(dest, fname));
    }

    const { files, bytes } = dirStats(dest);
    const resolved = await resolveBaseUrl(hint);
    return c.json(
      {
        slug,
        url: `${resolved.baseUrl}/${slug}/`,
        files,
        bytes,
        ...(resolved.warning ? { warning: resolved.warning } : {}),
      },
      201,
    );
  });

  app.get('/', (c) => {
    const publicDir = publicDirOf(deps.dataDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(publicDir, { withFileTypes: true });
    } catch {
      return c.json({ publishes: [] });
    }
    const publishes = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = join(publicDir, e.name);
        const { files, bytes } = dirStats(dir);
        return { slug: e.name, files, bytes, created: Math.round(statSync(dir).birthtimeMs) };
      })
      .sort((a, b) => b.created - a.created);
    return c.json({ publishes });
  });

  app.delete('/:slug', (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_RE.test(slug))
      return c.json({ error: { code: 'bad_request', message: 'bad slug' } }, 400);
    const dir = join(publicDirOf(deps.dataDir), slug);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      /* fall through to 404 */
    }
    if (!isDir)
      return c.json({ error: { code: 'not_found', message: `no such publish: ${slug}` } }, 404);
    // NOTE: deleting the last publish does NOT tear down the funnel — see
    // the plan doc. `tailscale funnel --https=8443 off` turns it off by hand.
    rmSync(dir, { recursive: true, force: true });
    return c.body(null, 204);
  });

  return app;
}
