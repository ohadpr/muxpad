import { IMAGE_MIME_BY_EXT, attachmentMime, imageExtForMime } from '@muxpad/shared';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
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

  // Agent-shared files: the agent-runner (same host) hands a SOURCE path and we
  // copy it into the served dir disk-to-disk — no memory buffering (unlike the
  // multipart upload above), which matters for large videos. Any supported
  // attachment type; the client renders each by extension.
  const MAX_BYTES = 512 * 1024 * 1024; // 512 MB — a sane ceiling for a recording
  app.post('/:paneId/attachments/by-path', async (c) => {
    const paneId = c.req.param('paneId');
    if (!panes.getById(paneId))
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
    const src = body?.path;
    if (!src || typeof src !== 'string')
      return c.json({ error: { code: 'bad_request', message: 'path is required' } }, 400);
    // Classify + derive the stored extension from the SAME slice attachmentMime
    // uses (last dot of the basename), not extname() — extname('/tmp/.png') is
    // '' and would store a name the serve route then can't classify (400s).
    const base = basename(src);
    const ext = base.slice(base.lastIndexOf('.')).toLowerCase();
    const mime = attachmentMime(base);
    if (!mime)
      return c.json(
        { error: { code: 'bad_request', message: `unsupported file type: ${extname(src) || src}` } },
        400,
      );
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(src);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      return c.json({ error: { code: 'not_found', message: `no such file: ${src}` } }, 404);
    }
    if (stat.size > MAX_BYTES)
      return c.json({ error: { code: 'too_large', message: 'file exceeds 512 MB' } }, 413);
    const dir = join(deps.dataDir, 'attachments');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${randomBytes(4).toString('hex')}${ext}`);
    copyFileSync(src, dest);
    deps.db
      .prepare('INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ulid(), paneId, mime, dest, Date.now());
    return c.json({ path: dest }, 201);
  });

  // Serve a stored attachment by bare filename so history thumbnails/players
  // load over HTTP from any device (the DB only keeps a host-local absolute
  // path). Locked to the flat attachments dir: basename-only (no traversal)
  // and a known attachment type. Streams (never buffers the whole file) and
  // honors Range so <video> can seek and only fetch the bytes it plays.
  app.get('/attachments/:name', (c) => {
    const name = c.req.param('name');
    if (name !== basename(name) || name.includes('\0'))
      return c.json({ error: { code: 'bad_request', message: 'bad name' } }, 400);
    const mime = attachmentMime(name);
    if (!mime)
      return c.json({ error: { code: 'bad_request', message: 'unsupported type' } }, 400);
    const path = join(deps.dataDir, 'attachments', name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return c.json({ error: { code: 'not_found', message: 'attachment not found' } }, 404);
    }
    const cache = 'private, max-age=31536000, immutable';
    const toWeb = (start?: number, end?: number) =>
      Readable.toWeb(createReadStream(path, start != null ? { start, end } : {})) as ReadableStream;

    const range = c.req.header('range');
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    // Require at least one bound (a bare `bytes=-` is malformed). Handle all
    // three RFC 7233 forms: `start-end`, `start-` (to EOF), and `-suffix`
    // (final N bytes — how players fetch an mp4/mov trailing index).
    if (m && (m[1] || m[2])) {
      let start: number;
      let end: number;
      if (!m[1]) {
        const suffix = Number.parseInt(m[2] ?? '', 10);
        start = Number.isNaN(suffix) ? 0 : Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number.parseInt(m[1], 10);
        // Open-ended runs to EOF; an over-long end clamps (satisfiable per spec).
        end = m[2] ? Math.min(Number.parseInt(m[2], 10), size - 1) : size - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size)
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      return new Response(toWeb(start, end), {
        status: 206,
        headers: {
          'content-type': mime,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes',
          'cache-control': cache,
        },
      });
    }
    return new Response(toWeb(), {
      headers: {
        'content-type': mime,
        'content-length': String(size),
        'accept-ranges': 'bytes',
        'cache-control': cache,
      },
    });
  });

  return app;
}
