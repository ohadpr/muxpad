import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
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
 * (personal tool). The one refusal is publishing the public dir into itself —
 * as the source, as an ancestor of the source, or (via a nested symlink) as a
 * descendant reached from inside it — all of which recurse into our own
 * output. See copyDereferenced.
 *
 * A named republish STAGES into a sibling temp dir and promotes by rename, so
 * a failed publish never destroys the version that was already live.
 *
 * VERSIONS
 * --------
 * The promote step used to `rm` the tree it moved aside. It now ROTATES it:
 * `<slug>` becomes `<slug>@2`, `@2` becomes `@3`, and the oldest falls off at
 * PUBLISH_VERSIONS_KEEP. Every version is a real directory under the public
 * root, so `/slug@2/` is served by the same static app with no new routing and
 * no new trust surface.
 *
 * Sibling directories rather than `<slug>/@2/` nested inside the current tree:
 * nesting would put history inside the thing being replaced (so every publish
 * would have to lift it out and put it back, losing atomicity), would fold
 * every old version into the current one's byte count, and would collide with a
 * source that happens to contain an `@2` entry. `@` cannot appear in SLUG_RE,
 * so `<slug>@<n>` can never collide with a real slug and the listing filter
 * already excludes them.
 *
 * The numbering is RELATIVE AGE (`@2` = previous), not a monotonic revision —
 * see ArtifactVersionSchema in @muxpad/shared for why.
 */

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/**
 * How many PREVIOUS versions of a named slug survive a republish. Three is a
 * rollback aid, not an archive: the artifacts are copies of trees that still
 * exist wherever they were built, and an unbounded chain would quietly turn the
 * public dir into a disk-eating mirror of every build ever made.
 */
export const PUBLISH_VERSIONS_KEEP = 3;

/** Directory name for version `n` (n ≥ 2) of `slug`. */
export function versionDirName(slug: string, n: number): string {
  return `${slug}@${n}`;
}

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

/** Age past which a leftover `.staging-*` / `.retired-*` dir is crash debris. */
const STALE_STAGING_MS = 60 * 60 * 1000;

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
  // A NESTED symlink can point at the public dir itself, an ANCESTOR of it
  // (like $HOME or /), or — just as bad — a DESCENDANT of it (another
  // publish, or the very destination we are writing into). Any of those makes
  // the copy re-enter our own output for an unbounded blow-up and mirrors
  // sensitive trees to the internet. The top-level guard in the route can't
  // see nested links — enforce all three directions here.
  //
  // The descendant case was the live hole: publishing a source containing
  // `loop -> <dataDir>/public/site` to slug `site` created the destination and
  // then copied it into itself, `site/loop/loop/…` down to MAX_COPY_DEPTH.
  // The cap bounded it but still allowed huge amplification, ENAMETOOLONG,
  // disk exhaustion and a long synchronous event-loop stall.
  const realPrefix = real.endsWith(sep) ? real : real + sep;
  const forbiddenPrefix = forbidden.endsWith(sep) ? forbidden : forbidden + sep;
  if (real === forbidden || forbidden.startsWith(realPrefix) || real.startsWith(forbiddenPrefix))
    return;
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

/**
 * Rotate `<slug>` into `<slug>@2`, shifting the existing chain up and dropping
 * whatever falls past the retention cap.
 *
 * Returns the path the CURRENT tree was moved to, so the caller can put it back
 * if the promote that follows fails. Pure renames on one filesystem: each is
 * atomic, and a crash mid-chain can at worst leave a gap in the history — never
 * damage the live version, which is not touched until the last step.
 */
export function rotateVersions(publicDir: string, slug: string): string | null {
  const dest = join(publicDir, slug);
  if (!existsSync(dest)) return null;
  // Drop the one about to fall off the end FIRST, so the shift below always
  // renames into a free name.
  rmSync(join(publicDir, versionDirName(slug, PUBLISH_VERSIONS_KEEP + 1)), {
    recursive: true,
    force: true,
  });
  for (let n = PUBLISH_VERSIONS_KEEP; n >= 2; n--) {
    const from = join(publicDir, versionDirName(slug, n));
    if (existsSync(from)) renameSync(from, join(publicDir, versionDirName(slug, n + 1)));
  }
  const retired = join(publicDir, versionDirName(slug, 2));
  renameSync(dest, retired);
  return retired;
}

/** Every existing version dir for `slug`, oldest-numbered first. */
function listVersionDirs(publicDir: string, slug: string): number[] {
  const out: number[] = [];
  for (let n = 2; n <= PUBLISH_VERSIONS_KEEP + 1; n++) {
    if (existsSync(join(publicDir, versionDirName(slug, n)))) out.push(n);
  }
  return out;
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
      update?: unknown;
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
    // `update: true` means "replace THIS existing artifact". The distinction
    // from a plain `name` is a safety one, and it is the point of the flag:
    // `--name` creates-or-replaces, so a typo silently mints a new artifact —
    // which is exactly how the live public dir accumulated trayo-creative,
    // trayo-creative2 … trayo-creative6 instead of six versions of one thing.
    // `--update` refuses to create, so a typo is a 404 you can read.
    const update = body?.update === true;
    if (update && typeof name !== 'string')
      return c.json({ error: { code: 'bad_request', message: 'update requires a name' } }, 400);
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

    // Named slug: republish-in-place semantics (the previous tree rotates to
    // @2). Random slug: 8 hex chars of crypto randomness, retried on the
    // ~impossible collision.
    let slug = typeof name === 'string' ? name : '';
    if (update && !existsSync(join(publicDir, slug)))
      return c.json(
        {
          error: {
            code: 'not_found',
            message: `no published artifact named ${slug} — publish it first, or drop --update to create it`,
          },
        },
        404,
      );
    if (!slug) {
      do {
        slug = randomBytes(4).toString('hex');
      } while (existsSync(join(publicDir, slug)));
    }
    // STAGE THEN SWAP. A republish used to `rmSync(dest)` and copy straight
    // into the live path: any failure part-way (disk full, permissions,
    // ENAMETOOLONG, the source changing under us) left a half-published
    // artifact AND had already destroyed the last known-good one, with no way
    // back. Now the new tree is built in a sibling temp dir on the same
    // filesystem, and only a successful build gets promoted by rename — so a
    // failure leaves the previous publish exactly as it was, and a reader
    // never sees a partial tree.
    //
    // The staging/retired names start with '.', which SLUG_RE cannot produce,
    // so they can never collide with a real slug; GET / filters them out, and
    // a crash between the two renames leaves at worst one `.retired-*` dir
    // that the sweep below removes on the next publish.
    const dest = join(publicDir, slug);
    const staging = join(publicDir, `.staging-${randomBytes(6).toString('hex')}`);
    for (const e of readdirSync(publicDir)) {
      if (!e.startsWith('.staging-') && !e.startsWith('.retired-')) continue;
      const stale = join(publicDir, e);
      try {
        // Age-gated so a concurrent publish's live staging dir is never the
        // one we sweep; anything this old is debris from a crash.
        //
        // btime is not universally available — libuv reports 0 where the
        // filesystem has none, which would make EVERY scratch dir look ancient
        // and let this delete a concurrent publish's live staging tree. Take
        // the NEWEST of the timestamps we have, so an unknown btime falls back
        // to mtime rather than to the epoch.
        const st = statSync(stale);
        const age = Date.now() - Math.max(st.birthtimeMs || 0, st.mtimeMs, st.ctimeMs);
        if (age < STALE_STAGING_MS) continue;
      } catch {
        continue;
      }
      rmSync(stale, { recursive: true, force: true });
    }
    mkdirSync(staging);
    try {
      if (st.isDirectory()) {
        copyDereferenced(srcPath, staging, realPub);
      } else {
        // A lone HTML file becomes the slug's index so the URL is just /<slug>/.
        const fname = /\.html?$/i.test(srcPath) ? 'index.html' : basename(srcPath);
        copyFileSync(srcPath, join(staging, fname));
      }
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      return c.json(
        {
          error: {
            code: 'internal',
            message: `publish failed, previous version left intact: ${(err as Error).message}`,
          },
        },
        500,
      );
    }

    const { files, bytes } = dirStats(staging);
    // Promote. The old tree moves aside by RENAME (instant, and reversible
    // right up to the swap) — but it is now rotated into `<slug>@2` and KEPT
    // rather than deleted, so the previous version stays addressable.
    let retired: string | null = null;
    try {
      retired = rotateVersions(publicDir, slug);
      renameSync(staging, dest);
    } catch (err) {
      // Put the old tree back if we managed to move it aside but not to swap
      // the new one in — better a stale publish than a missing one. (The older
      // versions may have shifted up a slot; that is history renumbering, not
      // data loss, and the LIVE artifact is what has to be right.)
      if (retired && !existsSync(dest)) {
        try {
          renameSync(retired, dest);
        } catch {
          // nothing more we can do; the retired copy stays on disk for a human
        }
      }
      rmSync(staging, { recursive: true, force: true });
      return c.json(
        {
          error: {
            code: 'internal',
            message: `publish failed, previous version left intact: ${(err as Error).message}`,
          },
        },
        500,
      );
    }
    const resolved = await resolveBaseUrl(hint);
    return c.json(
      {
        slug,
        url: `${resolved.baseUrl}/${slug}/`,
        files,
        bytes,
        versions: listVersionDirs(publicDir, slug).map((n) => ({
          n,
          url: `${resolved.baseUrl}/${versionDirName(slug, n)}/`,
        })),
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
    // Read-only base resolution: the PERSISTED value only, never a fresh
    // `tailscale` exec. A list is polled by the Hosted view; shelling out per
    // poll would be absurd, and under launchd the exec fails anyway. No
    // persisted base simply means `url: null` — the UI says "not public yet"
    // rather than printing a localhost URL that looks shareable and isn't.
    const base = globals.get(PUBLIC_BASE_URL_KEY);
    const publishes = entries
      // `.staging-*` / `.retired-*` are a republish's in-flight scratch dirs
      // (see POST); SLUG_RE can't produce a leading dot, so filtering by it
      // keeps them — and any other stray dotfile — out of the listing.
      // `<slug>@<n>` version dirs are excluded by the same test (SLUG_RE has no
      // '@'); they are reported as the owning artifact's `versions` instead of
      // masquerading as artifacts of their own.
      .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
      .map((e) => {
        const dir = join(publicDir, e.name);
        const { files, bytes } = dirStats(dir);
        return {
          slug: e.name,
          files,
          bytes,
          created: Math.round(statSync(dir).birthtimeMs),
          url: base ? `${base}/${e.name}/` : null,
          versions: listVersionDirs(publicDir, e.name).map((n) => {
            const vdir = join(publicDir, versionDirName(e.name, n));
            const stats = dirStats(vdir);
            return {
              n,
              files: stats.files,
              bytes: stats.bytes,
              created: Math.round(statSync(vdir).birthtimeMs),
              url: base ? `${base}/${versionDirName(e.name, n)}/` : null,
            };
          }),
        };
      })
      .sort((a, b) => b.created - a.created);
    return c.json({ publishes });
  });

  app.delete('/:slug', (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_RE.test(slug))
      return c.json({ error: { code: 'bad_request', message: 'bad slug' } }, 400);
    const publicDir = publicDirOf(deps.dataDir);
    const dir = join(publicDir, slug);
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
    // Versions go with it. Leaving them would make `/slug@2/` outlive a delete
    // the user believed removed the artifact from the internet — the one kind
    // of surprise a public surface must never spring.
    for (const n of listVersionDirs(publicDir, slug)) {
      rmSync(join(publicDir, versionDirName(slug, n)), { recursive: true, force: true });
    }
    return c.body(null, 204);
  });

  return app;
}
