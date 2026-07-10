import { IMAGE_MIME_BY_EXT, imageExtForMime } from '@muxpad/shared';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, extname } from 'node:path';
import { PaneStore } from '../store/PaneStore.js';

export function attachmentsRoutes(deps: {
  db: Database.Database;
  dataDir: string;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);

  app.post('/:paneId/attachments', async (c) => {
    const paneId = c.req.param('paneId');
    const pane = panes.getById(paneId);
    if (!pane)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);

    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File))
      return c.json({ error: { code: 'bad_request', message: 'file is required' } }, 400);

    // Only formats the WHOLE pipeline can handle: the thumbnail regex and the
    // serve route derive from the same shared map, so accepting anything else
    // here would store a file that renders as raw path text and 400s on GET.
    const extFromName = extname(file.name).toLowerCase();
    const ext =
      imageExtForMime(file.type) ?? (extFromName in IMAGE_MIME_BY_EXT ? extFromName : null);
    if (!ext)
      return c.json(
        { error: { code: 'bad_request', message: `unsupported image type: ${file.type || file.name}` } },
        400,
      );
    // Flat directory + short hex name keeps paths readable when the
    // user spots one on disk (or in a Claude prompt). 8 hex chars =
    // 4G unique names; collisions are statistically irrelevant for
    // a personal-use tool. The DB row's `id` (ulid below) still
    // gives us a stable, sortable PK.
    const dir = join(deps.dataDir, 'attachments');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${randomBytes(4).toString('hex')}${ext}`);
    writeFileSync(path, Buffer.from(await file.arrayBuffer()));

    deps.db
      .prepare(
        'INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ulid(), paneId, file.type, path, Date.now());

    return c.json({ path }, 201);
  });

  // Serve a stored attachment by bare filename so history thumbnails load over
  // HTTP from any device (the DB only keeps a host-local absolute path). Locked
  // to the flat attachments dir: basename-only (no traversal) and an image
  // extension, matching what the POST route ever writes.
  app.get('/attachments/:name', async (c) => {
    const name = c.req.param('name');
    if (name !== basename(name) || name.includes('\0'))
      return c.json({ error: { code: 'bad_request', message: 'bad name' } }, 400);
    const mime = IMAGE_MIME_BY_EXT[extname(name).toLowerCase() as keyof typeof IMAGE_MIME_BY_EXT];
    if (!mime)
      return c.json({ error: { code: 'bad_request', message: 'not an image' } }, 400);
    const path = join(deps.dataDir, 'attachments', name);
    if (!existsSync(path))
      return c.json({ error: { code: 'not_found', message: 'attachment not found' } }, 404);
    // Async read (never block the event loop on disk) — and a Buffer IS a
    // Uint8Array, so no copy is needed to hand it to Response.
    return new Response(await readFile(path), {
      headers: { 'content-type': mime, 'cache-control': 'private, max-age=31536000, immutable' },
    });
  });

  return app;
}
