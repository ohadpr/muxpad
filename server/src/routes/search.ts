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
 *   GET /api/search?q=<fts5 query>&limit=&sid=&role=&hosts=1
 *     → { query, fallback, hits: [{ sid, ts, role, snippet, session, host? }] }
 *     `q` is a raw FTS5 MATCH expression; a syntax error falls back to a
 *     quoted-phrase match (flagged via `fallback`) rather than 500ing.
 *
 *     `hosts=1` also asks every connected machine to search its own archive
 *     and merges the answers. THIS IS THE ONE CROSS-HOST SURFACE, and it is
 *     deliberately a server capability: a chat on any machine still sees only
 *     that machine through the in-pane `muxpad search`, while the person
 *     looking at a search box sees everything. Each remote hit carries a
 *     `host` name, and `machines` reports which ones answered — a machine
 *     that was asleep must not be indistinguishable from one with nothing in
 *     it.
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

export function searchRoutes(deps: {
  db: Database.Database;
  archive: ArchiveDb;
  /** Ask the other machines too, when `hosts=1`. Absent on a single-machine
   *  install, which makes the flag a no-op rather than an error. */
  searchHosts?: (
    q: string,
    opts: { limit: number; role?: string },
  ) => Promise<
    Array<{ nodeId: string; name: string; hits: unknown[]; fallback: boolean; error?: string }>
  >;
}): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
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
    const local = hits.map((h) => ({ ...h, session: metas.get(h.sid) }));
    // `sid` filters to ONE conversation, which belongs to one machine — so a
    // fan-out there is work no result can come of. (And `sid` is how the
    // transcript viewer pages a single chat.)
    const wantHosts = c.req.query('hosts') === '1' && !sid && !!deps.searchHosts;
    if (!wantHosts) return c.json({ query: q, fallback, hits: local });

    const remote = await (deps.searchHosts as NonNullable<typeof deps.searchHosts>)(q, {
      limit,
      ...(role ? { role } : {}),
    });
    /**
     * MERGED BY TIMESTAMP, not by rank.
     *
     * FTS5 `rank` is only comparable within one index — each machine's is
     * computed against its own corpus statistics, so interleaving two sets by
     * rank would be sorting by two different scales and the result would read
     * as arbitrary. Recency is a fact about the message itself and means the
     * same thing on every machine.
     */
    /** One row of the merged list. A remote hit's extra keys are what tell the
     *  UI which machine it came from; the rest of the shape is identical, so
     *  nothing downstream needs a branch. */
    type Row = Record<string, unknown> & { ts?: unknown };
    const rows: Row[] = [
      ...local,
      ...remote.flatMap((r) =>
        (r.hits as Array<Record<string, unknown>>).map((h) => ({
          // `session` ARRIVES WITH THE HIT, from that host's own archive —
          // this machine's tables know nothing of a remote sid, and a hit with
          // no session is a hit the UI drops as unnavigable. The pane id in it
          // DOES resolve here, because a remote pane's row lives on this
          // server with `node_id` set, so a cross-host result is a row you can
          // click and land in the chat.
          ...h,
          host: r.name,
          node_id: r.nodeId,
        })),
      ),
    ];
    const merged = rows.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
    return c.json({
      query: q,
      fallback: fallback || remote.some((r) => r.fallback),
      hits: merged.slice(0, limit),
      // Which machines were asked and what each said. The errors are the
      // point: "no results" and "the VM was asleep" are different answers.
      machines: [
        { node_id: 'local', name: 'this machine', hits: local.length },
        ...remote.map((r) => ({
          node_id: r.nodeId,
          name: r.name,
          hits: r.hits.length,
          ...(r.error ? { error: r.error } : {}),
        })),
      ],
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
