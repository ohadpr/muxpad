import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import {
  type ArchiveDb,
  type ArchiveSessionRow,
  MAX_SEARCH_QUERY_BYTES,
} from '../archive/ArchiveDb.js';

/**
 * Archive search + browse (docs/plans/2026-08-28-session-archive.md §3).
 *
 *   GET /api/search?q=<fts5 query>&limit=&sid=&role=
 *     → { query, fallback, hits: [{ sid, ts, role, snippet, session }] }
 *     `q` is a raw FTS5 MATCH expression; a syntax error falls back to a
 *     quoted-phrase match (flagged via `fallback`) rather than 500ing.
 *
 *   GET /api/archive/sessions?cwd=&limit=
 *     → { sessions: [...] } sorted by last_ts desc, enriched with the
 *     append-only session_history registry (pane/cwd provenance survives
 *     pane deletion there even when the transcript predates archiving).
 */

interface HistoryRow {
  sid: string;
  pane_id: string | null;
  assistant: string | null;
  cwd: string | null;
  first_seen: number | null;
  last_seen: number | null;
}

function historyFor(db: Database.Database, sid: string): HistoryRow | null {
  try {
    return (
      (db.prepare('SELECT * FROM session_history WHERE sid = ?').get(sid) as
        | HistoryRow
        | undefined) ?? null
    );
  } catch {
    return null;
  }
}

/** archive_sessions row merged with session_history provenance. */
function sessionMeta(
  db: Database.Database,
  archive: ArchiveDb,
  sid: string,
): Record<string, unknown> {
  const arch = archive.getSession(sid);
  const hist = historyFor(db, sid);
  return {
    sid,
    assistant: arch?.assistant ?? hist?.assistant ?? null,
    cwd: arch?.cwd ?? hist?.cwd ?? null,
    pane_id: arch?.pane_id ?? hist?.pane_id ?? null,
    project_dir: arch?.project_dir ?? null,
    first_ts: arch?.first_ts ?? null,
    last_ts: arch?.last_ts ?? null,
  };
}

export function searchRoutes(deps: { db: Database.Database; archive: ArchiveDb }): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const q = c.req.query('q')?.trim();
    if (!q) {
      return c.json({ error: { code: 'bad_request', message: 'q is required' } }, 400);
    }
    // FTS5 MATCH evaluation is synchronous on the main thread and its cost
    // grows with expression size — an unbounded q is a one-request freeze.
    if (Buffer.byteLength(q, 'utf8') > MAX_SEARCH_QUERY_BYTES) {
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: `q exceeds ${MAX_SEARCH_QUERY_BYTES} bytes`,
          },
        },
        400,
      );
    }
    const limitQ = Number(c.req.query('limit') ?? 20);
    const limit = Number.isInteger(limitQ) && limitQ > 0 ? Math.min(limitQ, 200) : 20;
    const sid = c.req.query('sid');
    const role = c.req.query('role');
    const { hits, fallback } = deps.archive.search(q, { sid, role, limit });
    // One metadata lookup per distinct sid, joined onto each hit.
    const metas = new Map<string, Record<string, unknown>>();
    for (const h of hits) {
      if (!metas.has(h.sid)) metas.set(h.sid, sessionMeta(deps.db, deps.archive, h.sid));
    }
    return c.json({
      query: q,
      fallback,
      hits: hits.map((h) => ({ ...h, session: metas.get(h.sid) })),
    });
  });
  return app;
}

export function archiveRoutes(deps: { db: Database.Database; archive: ArchiveDb }): Hono {
  const app = new Hono();
  app.get('/sessions', (c) => {
    const limitQ = Number(c.req.query('limit') ?? 100);
    const limit = Number.isInteger(limitQ) && limitQ > 0 ? Math.min(limitQ, 1000) : 100;
    const cwd = c.req.query('cwd');
    const sessions = deps.archive.listSessions({ cwd, limit }).map((s: ArchiveSessionRow) => {
      const hist = historyFor(deps.db, s.sid);
      return {
        ...s,
        assistant: s.assistant ?? hist?.assistant ?? null,
        cwd: s.cwd ?? hist?.cwd ?? null,
        pane_id: s.pane_id ?? hist?.pane_id ?? null,
      };
    });
    return c.json({ sessions });
  });
  return app;
}
