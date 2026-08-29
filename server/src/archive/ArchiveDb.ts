import Database from 'better-sqlite3';

/**
 * `archive.sqlite` — the session-archive index, deliberately a SEPARATE file
 * from the 192 KB operational db.sqlite: the FTS index will dwarf it and FTS
 * churn shouldn't share the WAL the UI reads. Same better-sqlite3 driver
 * (FTS5 is compiled in). See docs/plans/2026-08-28-session-archive.md §3.
 *
 * Tables:
 *   archive_files    — one row per SOURCE file (the offsets ledger). `offset`
 *                      is how many source bytes are mirrored (always a line
 *                      boundary), `indexed_offset` how many archive-file bytes
 *                      are FTS-indexed (lags/retries independently of the
 *                      copy). `version` counts compact-seals.
 *   archive_sessions — per-sid metadata for browsing (assistant, cwd, pane
 *                      provenance, first/last message ts).
 *   messages         — FTS5 index over normalized message text; sid/ts/role
 *                      ride along unindexed for filtering + result assembly.
 */
export interface ArchiveFileRow {
  source_path: string;
  sid: string;
  archived_path: string;
  offset: number;
  mtime: number;
  size: number;
  indexed_offset: number;
  version: number;
}

export interface ArchiveSessionRow {
  sid: string;
  assistant: string | null;
  cwd: string | null;
  pane_id: string | null;
  project_dir: string | null;
  first_ts: number | null;
  last_ts: number | null;
}

export interface MessageRow {
  text: string;
  sid: string;
  ts: number | null;
  role: string;
}

export interface SearchHit {
  sid: string;
  ts: number | null;
  role: string;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when `q` failed as a raw FTS5 expression and the quoted-phrase
   *  fallback was used instead. */
  fallback: boolean;
}

/**
 * Hard cap on the MATCH expression size. FTS5 evaluates the expression
 * synchronously; cost scales with its size, so an unbounded user-supplied
 * query is a single-request denial of service. 1 KiB comfortably covers any
 * real search. Enforced in ArchiveDb.search (throws RangeError), pre-checked
 * in the /api/search route (400) and the CLI.
 */
export const MAX_SEARCH_QUERY_BYTES = 1024;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS archive_files (
    source_path    TEXT PRIMARY KEY,
    sid            TEXT NOT NULL,
    archived_path  TEXT NOT NULL,
    offset         INTEGER NOT NULL DEFAULT 0,
    mtime          INTEGER NOT NULL DEFAULT 0,
    size           INTEGER NOT NULL DEFAULT 0,
    indexed_offset INTEGER NOT NULL DEFAULT 0,
    version        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS archive_files_sid ON archive_files(sid);
  CREATE TABLE IF NOT EXISTS archive_sessions (
    sid         TEXT PRIMARY KEY,
    assistant   TEXT,
    cwd         TEXT,
    pane_id     TEXT,
    project_dir TEXT,
    first_ts    INTEGER,
    last_ts     INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS messages
    USING fts5(text, sid UNINDEXED, ts UNINDEXED, role UNINDEXED);
`;

export class ArchiveDb {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── archive_files (offsets ledger) ────────────────────────────────────────

  getFile(sourcePath: string): ArchiveFileRow | null {
    return (
      (this.db.prepare('SELECT * FROM archive_files WHERE source_path = ?').get(sourcePath) as
        | ArchiveFileRow
        | undefined) ?? null
    );
  }

  listFiles(): ArchiveFileRow[] {
    return this.db.prepare('SELECT * FROM archive_files').all() as ArchiveFileRow[];
  }

  insertFile(row: { source_path: string; sid: string; archived_path: string }): ArchiveFileRow {
    this.db
      .prepare(
        `INSERT INTO archive_files (source_path, sid, archived_path)
         VALUES (?, ?, ?)
         ON CONFLICT(source_path) DO NOTHING`,
      )
      .run(row.source_path, row.sid, row.archived_path);
    return this.getFile(row.source_path) as ArchiveFileRow;
  }

  /** Is any row already mirroring into this archive-relative path? */
  archivedPathTaken(archivedPath: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM archive_files WHERE archived_path = ? LIMIT 1')
        .get(archivedPath) !== undefined
    );
  }

  setOffset(sourcePath: string, offset: number): void {
    this.db
      .prepare('UPDATE archive_files SET "offset" = ? WHERE source_path = ?')
      .run(offset, sourcePath);
  }

  setIndexedOffset(sourcePath: string, indexedOffset: number): void {
    this.db
      .prepare('UPDATE archive_files SET indexed_offset = ? WHERE source_path = ?')
      .run(indexedOffset, sourcePath);
  }

  touchFile(sourcePath: string, mtime: number, size: number): void {
    this.db
      .prepare('UPDATE archive_files SET mtime = ?, size = ? WHERE source_path = ?')
      .run(Math.round(mtime), size, sourcePath);
  }

  /** A compact/rewrite sealed the active copy: bump version, reset offsets. */
  sealFile(sourcePath: string, newVersion: number): void {
    this.db
      .prepare(
        `UPDATE archive_files
           SET version = ?, "offset" = 0, indexed_offset = 0
         WHERE source_path = ?`,
      )
      .run(newVersion, sourcePath);
  }

  // ── archive_sessions ──────────────────────────────────────────────────────

  getSession(sid: string): ArchiveSessionRow | null {
    return (
      (this.db.prepare('SELECT * FROM archive_sessions WHERE sid = ?').get(sid) as
        | ArchiveSessionRow
        | undefined) ?? null
    );
  }

  /** Upsert per-sid metadata; ts range widens, text fields fill in when known. */
  upsertSession(row: ArchiveSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO archive_sessions (sid, assistant, cwd, pane_id, project_dir, first_ts, last_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           assistant   = COALESCE(excluded.assistant, archive_sessions.assistant),
           cwd         = COALESCE(excluded.cwd, archive_sessions.cwd),
           pane_id     = COALESCE(excluded.pane_id, archive_sessions.pane_id),
           project_dir = COALESCE(excluded.project_dir, archive_sessions.project_dir),
           first_ts    = MIN(COALESCE(excluded.first_ts, archive_sessions.first_ts),
                             COALESCE(archive_sessions.first_ts, excluded.first_ts)),
           last_ts     = MAX(COALESCE(excluded.last_ts, archive_sessions.last_ts),
                             COALESCE(archive_sessions.last_ts, excluded.last_ts))`,
      )
      .run(
        row.sid,
        row.assistant,
        row.cwd,
        row.pane_id,
        row.project_dir,
        row.first_ts,
        row.last_ts,
      );
  }

  listSessions(
    opts: { cwd?: string | undefined; limit?: number | undefined } = {},
  ): ArchiveSessionRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    if (opts.cwd) {
      return this.db
        .prepare(
          `SELECT * FROM archive_sessions WHERE cwd LIKE ?
           ORDER BY last_ts DESC NULLS LAST LIMIT ?`,
        )
        .all(`%${opts.cwd}%`, limit) as ArchiveSessionRow[];
    }
    return this.db
      .prepare('SELECT * FROM archive_sessions ORDER BY last_ts DESC NULLS LAST LIMIT ?')
      .all(limit) as ArchiveSessionRow[];
  }

  // ── messages (FTS5) ───────────────────────────────────────────────────────

  /** Batched insert in one transaction — called per indexing slice. */
  insertMessages(rows: MessageRow[]): void {
    if (rows.length === 0) return;
    const ins = this.db.prepare('INSERT INTO messages (text, sid, ts, role) VALUES (?, ?, ?, ?)');
    this.db.transaction((batch: MessageRow[]) => {
      for (const r of batch) ins.run(r.text, r.sid, r.ts, r.role);
    })(rows);
  }

  /**
   * Insert a message batch AND advance the file's indexed_offset in the SAME
   * transaction, so a crash can't index lines without recording them (which
   * would double-index on resume) or vice versa.
   */
  indexBatch(sourcePath: string, rows: MessageRow[], newIndexedOffset: number): void {
    const ins = this.db.prepare('INSERT INTO messages (text, sid, ts, role) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const r of rows) ins.run(r.text, r.sid, r.ts, r.role);
      this.db
        .prepare('UPDATE archive_files SET indexed_offset = ? WHERE source_path = ?')
        .run(newIndexedOffset, sourcePath);
    })();
  }

  /**
   * FTS5 search. `q` is treated as a raw MATCH expression first; a syntax
   * error (unbalanced quotes, stray operators) falls back to a quoted-phrase
   * match instead of surfacing a 500 to the caller.
   *
   * Throws RangeError when `q` exceeds {@link MAX_SEARCH_QUERY_BYTES}: MATCH
   * evaluation is synchronous on the server's main thread and its cost grows
   * with expression size (a 10 KB expression measured >60 s against a real
   * index) — callers must reject long queries up front, never evaluate them.
   * Real I/O/corruption errors from SQLite propagate; only query-shaped
   * errors take the fallback path.
   */
  search(
    q: string,
    opts: { sid?: string | undefined; role?: string | undefined; limit?: number | undefined } = {},
  ): SearchResult {
    if (Buffer.byteLength(q, 'utf8') > MAX_SEARCH_QUERY_BYTES) {
      throw new RangeError(`search query exceeds ${MAX_SEARCH_QUERY_BYTES} bytes`);
    }
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.sid) {
      filters.push('AND sid = ?');
      params.push(opts.sid);
    }
    if (opts.role) {
      filters.push('AND role = ?');
      params.push(opts.role);
    }
    const sql = `
      SELECT sid, ts, role, snippet(messages, 0, '«', '»', '…', 16) AS snippet
      FROM messages
      WHERE messages MATCH ? ${filters.join(' ')}
      ORDER BY rank LIMIT ?`;
    const run = (match: string): SearchHit[] =>
      this.db.prepare(sql).all(match, ...params, limit) as SearchHit[];
    try {
      return { hits: run(q), fallback: false };
    } catch (err) {
      if (!isQueryError(err)) throw err; // disk/corruption — never mask as "no hits"
      // Raw expression failed to parse — quote the whole thing as a phrase
      // (embedded double-quotes doubled, per FTS5 string syntax).
      const phrase = `"${q.replace(/"/g, '""')}"`;
      try {
        return { hits: run(phrase), fallback: true };
      } catch (err2) {
        if (!isQueryError(err2)) throw err2;
        return { hits: [], fallback: true }; // q itself is unphrasable (e.g. only quotes)
      }
    }
  }
}

/**
 * Query-shaped FTS5 errors (bad user input → phrase fallback) vs real SQLite
 * failures (I/O, corruption → propagate). FTS5 reports query problems as
 * generic SQLITE_ERROR, so the message text is the only discriminator.
 */
function isQueryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /fts5|syntax error|unterminated string|unknown special query|no such column|unindexed/i.test(
    msg,
  );
}
