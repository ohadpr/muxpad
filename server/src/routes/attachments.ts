import { Hono } from 'hono';
import { ulid } from 'ulid';
import type Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
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

    const ext = extname(file.name) || mimeExt(file.type);
    const dir = join(deps.dataDir, 'attachments', pane.workspace_id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${ulid()}${ext}`);
    writeFileSync(path, Buffer.from(await file.arrayBuffer()));

    deps.db
      .prepare(
        'INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ulid(), paneId, file.type, path, Date.now());

    return c.json({ path }, 201);
  });

  return app;
}

function mimeExt(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  return '.bin';
}
