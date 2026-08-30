import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { APP_SLUG_RE, type App } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppRegistry } from '../apps/AppRegistry.js';
import type { AppStatusProbe } from '../apps/AppStatus.js';
import { AppStore } from '../store/AppStore.js';
import { classifyUrlHost } from '../url-health.js';

/**
 * REST for `muxpad app` — the Hosted surface's APP half.
 *
 * Thin by design: every lifecycle decision lives in apps/AppRegistry.ts and
 * every status judgement in apps/AppStatus.ts. What lives HERE is validation,
 * because three of these fields are consequential:
 *
 *   command  is pasted into a shell line inside the app's pane. That is the
 *            feature (an app IS a command you'd otherwise type), so the check
 *            is for shape — no newlines, which would smuggle a SECOND command
 *            past the `muxpad serve` wrapper and out of its supervision — not
 *            for content.
 *   url      is probed by the server and mounted in an iframe. Must be a real
 *            http(s) URL, and must not contain the quote character the startup
 *            command wraps it in.
 *   cwd      becomes a pane's working directory. Must exist NOW: safeCwd would
 *            silently fall back to $HOME, and an app quietly running in the
 *            wrong directory is far worse than a 400.
 *
 * Routes:
 *   GET    /api/apps            → { apps: AppWithStatus[] }   (status measured)
 *   POST   /api/apps            → AppWithStatus, 201
 *   GET    /api/apps/:ref       → AppWithStatus                (ref = id | slug)
 *   PATCH  /api/apps/:ref       → AppWithStatus
 *   POST   /api/apps/:ref/start → AppWithStatus
 *   POST   /api/apps/:ref/stop  → AppWithStatus
 *   DELETE /api/apps/:ref       → 204
 */

/** Newlines would let a second command escape the `muxpad serve` wrapper. */
const COMMAND_RE = /^[^\n\r\0]{1,1000}$/;

export function appsRoutes(deps: {
  db: Database.Database;
  registry?: AppRegistry | undefined;
  status?: AppStatusProbe | undefined;
}): Hono {
  const app = new Hono();
  const apps = new AppStore(deps.db);

  const bad = (message: string) => ({ error: { code: 'bad_request' as const, message } });
  const notFound = (message: string) => ({ error: { code: 'not_found' as const, message } });

  /**
   * Decorate for the wire. Without a status probe (HTTP-only tests) the row is
   * returned with a HONEST unknown rather than a fabricated 'running': `state`
   * follows the enabled flag, `pty`/`health` are null. Never invent status.
   */
  const decorate = async (row: App) => {
    if (deps.status) return deps.status.status(row);
    return {
      ...row,
      state: row.enabled ? ('starting' as const) : ('stopped' as const),
      pty: null,
      health: null,
    };
  };

  /** Validate a URL for both the probe and the iframe. */
  function badUrl(url: string): string | null {
    if (/['"\s\0]/.test(url)) return 'url must not contain quotes or whitespace';
    if (classifyUrlHost(url) === null) return 'url must be a well-formed http(s) URL';
    return null;
  }

  function badCwd(cwd: string): string | null {
    if (!isAbsolute(cwd)) return 'cwd must be an absolute path';
    try {
      if (!statSync(cwd).isDirectory()) return `not a directory: ${cwd}`;
    } catch {
      return `no such directory: ${cwd}`;
    }
    return null;
  }

  app.get('/', async (c) => {
    return c.json({ apps: await Promise.all(apps.list().map(decorate)) });
  });

  app.post('/', async (c) => {
    if (!deps.registry) return c.json(bad('app registry unavailable'), 503);
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(64),
        cwd: z.string().min(1),
        command: z.string().trim().regex(COMMAND_RE, 'command must be a single line'),
        url: z.string().min(1).max(512),
        slug: z.string().regex(APP_SLUG_RE, 'slug must match [a-z0-9][a-z0-9-]{0,63}').optional(),
        autostart: z.boolean().optional(),
        /** Register without bringing it up. Lands as enabled = 0 — a real
         *  "stopped", not an enabled row with no process behind it. */
        start: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json(bad(parsed.error.errors[0]?.message ?? 'invalid request'), 400);
    const body = parsed.data;

    const urlErr = badUrl(body.url);
    if (urlErr) return c.json(bad(urlErr), 400);
    const cwdErr = badCwd(body.cwd);
    if (cwdErr) return c.json(bad(cwdErr), 400);

    const base = body.slug ?? AppStore.slugify(body.name);
    if (!base) return c.json(bad('could not derive a slug from that name — pass --slug'), 400);
    // An explicit slug is taken literally: silently renaming what the caller
    // asked for would break the handle they are about to script against.
    if (body.slug && apps.getBySlug(body.slug))
      return c.json(
        { error: { code: 'conflict', message: `an app named ${body.slug} already exists` } },
        409,
      );
    const slug = body.slug ?? apps.uniqueSlug(base);

    const shouldStart = body.start ?? true;
    const created = apps.create({
      slug,
      name: body.name,
      cwd: body.cwd,
      command: body.command,
      url: body.url,
      autostart: body.autostart ?? true,
      enabled: shouldStart,
    });
    if (shouldStart) await deps.registry.materialize(created.id);
    deps.status?.invalidate(created.id);
    const fresh = apps.getById(created.id) as App;
    return c.json(await decorate(fresh), 201);
  });

  app.get('/:ref', async (c) => {
    const row = apps.resolve(c.req.param('ref'));
    if (!row) return c.json(notFound(`no such app: ${c.req.param('ref')}`), 404);
    return c.json(await decorate(row));
  });

  app.patch('/:ref', async (c) => {
    if (!deps.registry) return c.json(bad('app registry unavailable'), 503);
    const row = apps.resolve(c.req.param('ref'));
    if (!row) return c.json(notFound(`no such app: ${c.req.param('ref')}`), 404);
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(64).optional(),
        cwd: z.string().min(1).optional(),
        command: z.string().trim().regex(COMMAND_RE, 'command must be a single line').optional(),
        url: z.string().min(1).max(512).optional(),
        autostart: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json(bad(parsed.error.errors[0]?.message ?? 'invalid request'), 400);
    const patch = parsed.data;
    if (patch.url !== undefined) {
      const err = badUrl(patch.url);
      if (err) return c.json(bad(err), 400);
    }
    if (patch.cwd !== undefined) {
      const err = badCwd(patch.cwd);
      if (err) return c.json(bad(err), 400);
    }

    // cwd / command / url / name are all baked into the pane's startup command,
    // which is only read when the pty is created. Editing them on a RUNNING app
    // would otherwise take effect at some unpredictable future respawn — the
    // registry would say one thing and the process be doing another. Rebuild
    // instead, and say so in the response by way of the fresh pane id.
    const rebuildKeys = ['cwd', 'command', 'url', 'name'] as const;
    const needsRebuild =
      row.enabled && rebuildKeys.some((k) => patch[k] !== undefined && patch[k] !== row[k]);

    apps.update(row.id, patch);
    if (needsRebuild) {
      await deps.registry.stop(row.id);
      await deps.registry.start(row.id);
    }
    deps.status?.invalidate(row.id);
    return c.json(await decorate(apps.getById(row.id) as App));
  });

  app.post('/:ref/start', async (c) => {
    if (!deps.registry) return c.json(bad('app registry unavailable'), 503);
    const row = apps.resolve(c.req.param('ref'));
    if (!row) return c.json(notFound(`no such app: ${c.req.param('ref')}`), 404);
    await deps.registry.start(row.id);
    deps.status?.invalidate(row.id);
    return c.json(await decorate(apps.getById(row.id) as App));
  });

  app.post('/:ref/stop', async (c) => {
    if (!deps.registry) return c.json(bad('app registry unavailable'), 503);
    const row = apps.resolve(c.req.param('ref'));
    if (!row) return c.json(notFound(`no such app: ${c.req.param('ref')}`), 404);
    await deps.registry.stop(row.id);
    deps.status?.invalidate(row.id);
    return c.json(await decorate(apps.getById(row.id) as App));
  });

  app.delete('/:ref', async (c) => {
    if (!deps.registry) return c.json(bad('app registry unavailable'), 503);
    const row = apps.resolve(c.req.param('ref'));
    if (!row) return c.json(notFound(`no such app: ${c.req.param('ref')}`), 404);
    await deps.registry.remove(row.id);
    deps.status?.invalidate(row.id);
    return c.body(null, 204);
  });

  return app;
}
