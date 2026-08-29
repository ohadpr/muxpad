import type { Dirent } from 'node:fs';
import { appendFile, mkdir, open, readdir, rename, stat, truncate } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { findTranscript } from '../chat/TranscriptReader.js';
import type { EventBus } from '../events.js';
import type { ArchiveDb, ArchiveFileRow, MessageRow } from './ArchiveDb.js';

/**
 * Session archiver — muxpad permanently owns a raw, byte-for-byte copy of
 * every agent-session transcript (docs/plans/2026-08-28-session-archive.md §2).
 *
 * Sources:
 *   - Claude project transcripts:  <claudeProjectsDir>/<proj>/<sid>.jsonl
 *   - Claude subagent transcripts: <claudeProjectsDir>/<proj>/<sid>/subagents/*.jsonl
 *   - muxpad-owned normalized logs (codex/cursor): <muxpadTranscriptsDir>/<sid>.jsonl
 *
 * Copy discipline (TranscriptTail's byte-offset model, sinking raw bytes):
 *   - Append-only from the last recorded offset; the offset only ever advances
 *     past COMPLETE lines, so a live writer's torn trailing line is never
 *     mirrored (and interleaving can never corrupt a line).
 *   - If a source file SHRANK (a /compact rewrite), the current archive copy
 *     is sealed as `<sid>.v<N>.jsonl` and a fresh copy starts from byte 0 —
 *     nothing is ever overwritten or lost.
 *   - A source that VANISHED (migrateTranscript deletes its file after
 *     concatenating into the new sid's log; Claude's 30-day reaper) is fine:
 *     the archive copy up to the recorded offset simply stands.
 *
 * Indexing: as bytes land in the archive, each complete line is parsed +
 * normalized (lossy is CORRECT here — the index is for finding, the raw file
 * is for reading) and inserted into the FTS5 `messages` table. The indexed
 * offset is tracked separately from the copy offset and only advances past
 * complete parsed lines, inside the same transaction as the insert batch.
 *
 * Nothing here blocks the event loop on big files: all I/O is fs/promises in
 * bounded chunks, and the sweep drains its queue a few files at a time.
 */

type SourceKind = 'claude' | 'claude-subagent' | 'muxpad';

interface QueueItem {
  path: string;
  sid: string;
  kind: SourceKind;
  /** Claude project dir name (provenance for archive_sessions). */
  projectDir?: string | undefined;
}

export interface ArchiverOpts {
  archive: ArchiveDb;
  /** Where raw mirrors land: `<dataDir>/archive`. */
  archiveDir: string;
  /** `$CLAUDE_CONFIG_DIR/projects` (or ~/.claude/projects) — pass explicitly. */
  claudeProjectsDir: string;
  /** `<dataDir>/agent-transcripts` — pass explicitly, derived from config. */
  muxpadTranscriptsDir: string;
  /** Main db, for agent_sessions lookups (sid-change trigger) and
   *  session_history enrichment of archive_sessions. Optional in unit tests. */
  db?: Database.Database | undefined;
  /** Bus for the near-realtime triggers (agent_turn done, sid changes). */
  events?: EventBus | undefined;
  /** Periodic sweep cadence. Default 15 min. */
  sweepIntervalMs?: number | undefined;
  /** Copy/index read chunk. Default 1 MiB. */
  chunkBytes?: number | undefined;
  /** How many queued files archive concurrently. Default 3. */
  concurrency?: number | undefined;
}

const DEFAULT_CHUNK = 1024 * 1024;
const NL = 0x0a;
/** FTS batch size — bounds each insert transaction. */
const INDEX_BATCH_LINES = 500;
/** ChatEvent kinds whose text is worth finding again. */
const INDEXED_KINDS = new Set(['user', 'assistant', 'thinking', 'notice']);

export class Archiver {
  private readonly archive: ArchiveDb;
  private readonly archiveDir: string;
  private readonly claudeProjectsDir: string;
  private readonly muxpadTranscriptsDir: string;
  private readonly db: Database.Database | undefined;
  private readonly events: EventBus | undefined;
  private readonly sweepIntervalMs: number;
  private readonly chunkBytes: number;
  private readonly concurrency: number;

  private readonly pending = new Map<string, QueueItem>();
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Last sid seen per pane — the sid-change trigger's memory. */
  private readonly paneSids = new Map<string, { sid: string; assistant: string }>();
  private closed = false;

  constructor(opts: ArchiverOpts) {
    this.archive = opts.archive;
    this.archiveDir = opts.archiveDir;
    this.claudeProjectsDir = opts.claudeProjectsDir;
    this.muxpadTranscriptsDir = opts.muxpadTranscriptsDir;
    this.db = opts.db;
    this.events = opts.events;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 15 * 60_000;
    this.chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK;
    this.concurrency = opts.concurrency ?? 3;
  }

  /** Boot: subscribe triggers, kick the backfill sweep, arm the 15-min timer. */
  start(): void {
    if (this.events) {
      this.unsubscribe = this.events.subscribe((e) => {
        if (e.type === 'agent_turn' && e.phase === 'done' && e.sid) {
          this.enqueueSid(e.sid, e.backend);
        } else if (e.type === 'agent_session.updated') {
          this.onSessionUpdated(e.pane_id);
        }
      });
    }
    void this.sweep().catch((err) => console.error('[archive] boot sweep failed', err));
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => console.error('[archive] sweep failed', err));
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }

  /** In-flight work settles (tests await this between assertions). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * Scan both transcript trees for files that are new or have grown/shrunk vs
   * the recorded offsets, queue them, and drain the queue. This is what makes
   * the archive "all sessions" — TUI `muxpad claude` panes, sessions started
   * outside muxpad, and subagent sidechains all land here even though no
   * in-process trigger ever fires for them.
   */
  async sweep(): Promise<void> {
    if (this.closed) return;
    const candidates = [...(await this.listClaudeFiles()), ...(await this.listMuxpadFiles())];
    for (const item of candidates) {
      let st: { size: number } | null = null;
      try {
        st = await stat(item.path);
      } catch {
        continue; // vanished between readdir and stat
      }
      const row = this.archive.getFile(item.path);
      if (row && st.size === row.offset && row.indexed_offset >= row.offset) continue; // fully mirrored
      this.enqueue(item);
    }
    await this.drain();
  }

  /** Queue one file (deduped by path) and make sure the drain loop is running. */
  enqueue(item: QueueItem): void {
    if (this.closed) return;
    this.pending.set(item.path, item);
    void this.drain();
  }

  /** Near-realtime trigger: a turn finished (or a sid changed) for `sid`. */
  enqueueSid(sid: string, backend: string): void {
    if (backend === 'claude') {
      const path = findTranscript(sid, this.claudeProjectsDir);
      if (path) {
        this.enqueue({ path, sid, kind: 'claude', projectDir: basename(dirname(path)) });
        // The turn may have spawned subagents — their sidechain files live in
        // `<proj>/<sid>/subagents/`. Best-effort; the sweep is the backstop.
        void this.enqueueSubagents(dirname(path), sid);
      }
    } else {
      const path = join(this.muxpadTranscriptsDir, `${sid}.jsonl`);
      this.enqueue({ path, sid, kind: 'muxpad' });
    }
  }

  // ── enumeration ───────────────────────────────────────────────────────────

  private async listClaudeFiles(): Promise<QueueItem[]> {
    const out: QueueItem[] = [];
    let projects: string[] = [];
    try {
      projects = await readdir(this.claudeProjectsDir);
    } catch {
      return out; // no Claude installation / fixture dir absent
    }
    for (const proj of projects) {
      const projPath = join(this.claudeProjectsDir, proj);
      let entries: Dirent[];
      try {
        entries = await readdir(projPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const name = e.name;
        if (e.isFile() && name.endsWith('.jsonl')) {
          out.push({
            path: join(projPath, name),
            sid: name.slice(0, -'.jsonl'.length),
            kind: 'claude',
            projectDir: proj,
          });
        } else if (e.isDirectory()) {
          // Per-session dir: <proj>/<sid>/subagents/agent-<id>.jsonl
          let subs: string[] = [];
          try {
            subs = await readdir(join(projPath, name, 'subagents'));
          } catch {
            continue; // no subagents dir — the common case
          }
          for (const s of subs) {
            if (!s.endsWith('.jsonl')) continue;
            out.push({
              path: join(projPath, name, 'subagents', s),
              sid: s.slice(0, -'.jsonl'.length),
              kind: 'claude-subagent',
              projectDir: proj,
            });
          }
        }
      }
    }
    return out;
  }

  private async listMuxpadFiles(): Promise<QueueItem[]> {
    const out: QueueItem[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(this.muxpadTranscriptsDir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      out.push({
        path: join(this.muxpadTranscriptsDir, name),
        sid: name.slice(0, -'.jsonl'.length),
        kind: 'muxpad',
      });
    }
    return out;
  }

  private async enqueueSubagents(projPath: string, sid: string): Promise<void> {
    let subs: string[] = [];
    try {
      subs = await readdir(join(projPath, sid, 'subagents'));
    } catch {
      return;
    }
    for (const s of subs) {
      if (!s.endsWith('.jsonl')) continue;
      this.enqueue({
        path: join(projPath, sid, 'subagents', s),
        sid: s.slice(0, -'.jsonl'.length),
        kind: 'claude-subagent',
        projectDir: basename(projPath),
      });
    }
  }

  // ── triggers ──────────────────────────────────────────────────────────────

  /**
   * sid-change detector: on any session update, enqueue both the old and the
   * new sid's files. REALITY CHECK on the old sid: migrateTranscript runs in
   * the RUNNER process before its hello ever reaches the server, so by the
   * time this fires the old file is usually already deleted (concatenated
   * into the new sid's file) — the enqueue then no-ops on ENOENT. That's
   * fine: durability comes from mirroring the NEW file, whose prepended
   * old-history the rewrite detection in archiveOne handles (seal + recopy
   * from 0), not from winning a race we structurally lose.
   */
  private onSessionUpdated(paneId: string): void {
    if (!this.db) return;
    let row: { current_sid: string | null; assistant: string } | undefined;
    try {
      row = this.db
        .prepare('SELECT current_sid, assistant FROM agent_sessions WHERE pane_id = ?')
        .get(paneId) as { current_sid: string | null; assistant: string } | undefined;
    } catch {
      return;
    }
    const prev = this.paneSids.get(paneId);
    const sid = row?.current_sid ?? null;
    if (!sid) return;
    if (prev?.sid === sid) return;
    this.paneSids.set(paneId, { sid, assistant: row?.assistant ?? 'claude' });
    // Best-effort only (see docstring): usually already deleted by migrate.
    if (prev) this.enqueueSid(prev.sid, prev.assistant);
    this.enqueueSid(sid, row?.assistant ?? 'claude');
  }

  // ── queue drain ───────────────────────────────────────────────────────────

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = (async () => {
      // Suspend for one microtask BEFORE any work: an async IIFE runs
      // synchronously up to its first await, so with an empty queue the
      // finally below would otherwise clear `this.draining` before the
      // `this.draining = run` assignment — leaving a permanently-settled
      // promise in the slot that every later drain() short-circuits on
      // (archiver bricked; idle() spins on an always-resolved promise).
      await Promise.resolve();
      try {
        while (this.pending.size > 0 && !this.closed) {
          const batch = [...this.pending.values()].slice(0, this.concurrency);
          for (const b of batch) this.pending.delete(b.path);
          await Promise.all(
            batch.map((item) =>
              this.archiveOne(item).catch((err) =>
                console.error(`[archive] failed on ${item.path}`, err),
              ),
            ),
          );
        }
      } finally {
        this.draining = null;
        // An enqueue that raced the loop's exit check would otherwise sit
        // until the next sweep — re-kick if anything landed meanwhile.
        if (this.pending.size > 0 && !this.closed) void this.drain();
      }
    })();
    this.draining = run;
    return run;
  }

  // ── per-file archive + index ──────────────────────────────────────────────

  private async archiveOne(item: QueueItem): Promise<void> {
    let st: { size: number; mtimeMs: number };
    try {
      st = await stat(item.path);
    } catch {
      // Source vanished (migrateTranscript's delete, Claude's reaper). The
      // archive copy up to the recorded offset stands — done, not an error.
      return;
    }
    await mkdir(this.archiveDir, { recursive: true });
    let row = this.archive.getFile(item.path);
    if (!row) {
      row = this.archive.insertFile({
        source_path: item.path,
        sid: item.sid,
        archived_path: this.allocArchivedPath(item.sid),
      });
    }
    // A rewrite invalidates the mirrored prefix two ways: the file SHRANK
    // (compact), or it GREW but the already-mirrored region no longer matches
    // — migrateTranscript PREPENDS the old sid's history into the new sid's
    // file, so byte `offset` of the source is suddenly mid-old-history and a
    // blind append would interleave old and new lines into the mirror.
    // Either way: index any copy-tail the indexer hadn't reached, seal the
    // current mirror as a version, start a fresh copy from byte 0.
    const rewritten =
      st.size < row.offset ||
      (row.offset > 0 && st.size > row.offset && !(await this.mirrorMatchesSource(row, item.path)));
    if (rewritten) {
      await this.indexRow(row, item);
      await this.seal(row);
      row = this.archive.getFile(item.path) as ArchiveFileRow;
    }
    if (st.size > row.offset) {
      await this.copyAppend(row, item.path, st.size);
      row = this.archive.getFile(item.path) as ArchiveFileRow;
    }
    await this.indexRow(row, item);
    this.archive.touchFile(item.path, st.mtimeMs, st.size);
  }

  /**
   * `<sid>.jsonl` normally; a DIFFERENT source file already mirroring under
   * that sid (Claude re-keys the transcript dir on cwd switch, so one sid can
   * have several source files) gets a discriminated name — two live writers
   * interleaving into one mirror would tear lines.
   */
  private allocArchivedPath(sid: string): string {
    const base = `${sid}.jsonl`;
    if (!this.archive.archivedPathTaken(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${sid}.${n}.jsonl`;
      if (!this.archive.archivedPathTaken(candidate)) return candidate;
    }
  }

  /**
   * Is the source's [0, offset) region still the bytes we mirrored? Compares
   * the head and tail (up to 4 KiB each) of the mirrored region — a prepend
   * shifts every byte, so either probe catches it; mtime can't distinguish a
   * legitimate append from a rewrite, content can. A missing/short mirror
   * also reads as a mismatch (data hole → recopy from scratch, never a blind
   * append over a gap).
   */
  private async mirrorMatchesSource(row: ArchiveFileRow, sourcePath: string): Promise<boolean> {
    const VERIFY_BYTES = 4096;
    const archAbs = join(this.archiveDir, row.archived_path);
    const readSlice = async (path: string, from: number, len: number): Promise<Buffer | null> => {
      let fh: Awaited<ReturnType<typeof open>>;
      try {
        fh = await open(path, 'r');
      } catch {
        return null;
      }
      try {
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, from);
        return bytesRead === len ? buf : null; // short read = mismatch
      } finally {
        await fh.close();
      }
    };
    const probes: Array<[from: number, len: number]> = [];
    const headLen = Math.min(VERIFY_BYTES, row.offset);
    probes.push([0, headLen]);
    if (row.offset > VERIFY_BYTES) {
      probes.push([row.offset - VERIFY_BYTES, VERIFY_BYTES]);
    }
    for (const [from, len] of probes) {
      const src = await readSlice(sourcePath, from, len);
      const arch = await readSlice(archAbs, from, len);
      if (!src || !arch || !src.equals(arch)) return false;
    }
    return true;
  }

  /** Seal `<name>.jsonl` → `<name>.v<N>.jsonl`; the ledger resets to byte 0. */
  private async seal(row: ArchiveFileRow): Promise<void> {
    const version = row.version + 1;
    const active = join(this.archiveDir, row.archived_path);
    const sealed = join(
      this.archiveDir,
      row.archived_path.replace(/\.jsonl$/, `.v${version}.jsonl`),
    );
    try {
      await rename(active, sealed);
    } catch {
      // Active copy missing (never written / already sealed) — reset anyway.
    }
    this.archive.sealFile(row.source_path, version);
  }

  /**
   * Append source bytes [row.offset, size) to the archive mirror, complete
   * lines only. Chunked async reads; the ledger offset advances after each
   * append so a crash resumes precisely.
   */
  private async copyAppend(row: ArchiveFileRow, sourcePath: string, size: number): Promise<void> {
    const archAbs = join(this.archiveDir, row.archived_path);
    // Crash discipline: the mirror's length must equal the ledger offset
    // minus nothing — we append complete lines then record. If a previous
    // process died between append and record, trim the mirror back to the
    // recorded offset rather than duplicating those bytes.
    try {
      const archSt = await stat(archAbs);
      if (archSt.size > row.offset) await truncate(archAbs, row.offset);
    } catch {
      // Mirror doesn't exist yet — appendFile creates it.
    }
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(sourcePath, 'r');
    } catch {
      return; // vanished mid-flight; what's mirrored stands
    }
    try {
      let archived = row.offset; // source bytes fully mirrored (line boundary)
      let readPos = row.offset; // source bytes consumed into `carry`
      let carry: Buffer = Buffer.alloc(0); // tail with no newline yet
      while (readPos < size) {
        const len = Math.min(this.chunkBytes, size - readPos);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, readPos);
        if (bytesRead <= 0) break;
        readPos += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        carry = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const nl = carry.lastIndexOf(NL);
        if (nl === -1) continue; // one giant line spanning chunks — keep reading
        await appendFile(archAbs, carry.subarray(0, nl + 1));
        archived += nl + 1;
        this.archive.setOffset(row.source_path, archived);
        carry = Buffer.from(carry.subarray(nl + 1)); // copy: detach from big buf
      }
      // Trailing newline-less bytes stay unmirrored — a live writer's torn
      // line. The next trigger/sweep picks them up once the newline lands.
    } finally {
      await fh.close();
    }
  }

  /**
   * Index archive bytes [indexed_offset, offset). The mirror holds only
   * complete lines below `offset`, so every line in range parses whole; the
   * indexed offset still only advances past lines actually consumed, in the
   * same transaction as their FTS insert.
   */
  private async indexRow(row: ArchiveFileRow, item: QueueItem): Promise<void> {
    let { indexed_offset: from } = row;
    const to = row.offset;
    if (from >= to) return;
    const archAbs = join(this.archiveDir, row.archived_path);
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(archAbs, 'r');
    } catch {
      return;
    }
    const meta = {
      cwd: null as string | null,
      firstTs: null as number | null,
      lastTs: null as number | null,
    };
    try {
      let carry: Buffer = Buffer.alloc(0);
      let carryStart = from; // archive offset where `carry` begins
      let readPos = from;
      let batch: MessageRow[] = [];
      let batchEnd = from; // archive offset just past the last batched line
      const flush = () => {
        if (batchEnd > from) {
          this.archive.indexBatch(row.source_path, batch, batchEnd);
          from = batchEnd;
        }
        batch = [];
      };
      while (readPos < to) {
        const len = Math.min(this.chunkBytes, to - readPos);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, readPos);
        if (bytesRead <= 0) break;
        readPos += bytesRead;
        carry =
          carry.length > 0
            ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
            : buf.subarray(0, bytesRead);
        for (;;) {
          const nl = carry.indexOf(NL);
          if (nl === -1) break;
          const lineEnd = carryStart + nl + 1;
          const line = carry.toString('utf8', 0, nl);
          carry = Buffer.from(carry.subarray(nl + 1));
          carryStart = lineEnd;
          batch.push(...this.linesFor(line, item, meta));
          batchEnd = lineEnd;
          if (batch.length >= INDEX_BATCH_LINES) flush();
        }
      }
      flush();
    } finally {
      await fh.close();
    }
    this.updateSessionMeta(item, meta);
  }

  /** Normalize one raw line into indexable message rows (+ harvest metadata). */
  private linesFor(
    line: string,
    item: QueueItem,
    meta: { cwd: string | null; firstTs: number | null; lastTs: number | null },
  ): MessageRow[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return []; // torn/garbage line — mirrored verbatim, just not indexed
    }
    if (obj === null || typeof obj !== 'object') return [];
    const raw = obj as Record<string, unknown>;
    if (item.kind !== 'muxpad' && typeof raw.cwd === 'string' && !meta.cwd) meta.cwd = raw.cwd;
    let events: ChatEvent[];
    if (item.kind === 'muxpad') {
      // muxpad log lines already ARE ChatEvents.
      events = [obj as ChatEvent];
    } else if (item.kind === 'claude-subagent') {
      // Subagent transcripts are ALL sidechain lines — the very thing the
      // normalizer drops. Clear the flag so their content indexes too.
      events = normalizeTranscriptLine({ ...raw, isSidechain: false });
    } else {
      events = normalizeTranscriptLine(obj);
    }
    const out: MessageRow[] = [];
    for (const e of events) {
      if (typeof e.ts === 'number') {
        if (meta.firstTs === null || e.ts < meta.firstTs) meta.firstTs = e.ts;
        if (meta.lastTs === null || e.ts > meta.lastTs) meta.lastTs = e.ts;
      }
      if (!INDEXED_KINDS.has(e.kind)) continue;
      const text = (e as { text?: unknown }).text;
      if (typeof text !== 'string' || !text.trim()) continue;
      out.push({ text, sid: item.sid, ts: e.ts, role: e.kind });
    }
    return out;
  }

  /** Refresh archive_sessions for this sid, enriched from session_history. */
  private updateSessionMeta(
    item: QueueItem,
    meta: { cwd: string | null; firstTs: number | null; lastTs: number | null },
  ): void {
    let history:
      | { pane_id: string | null; assistant: string | null; cwd: string | null }
      | undefined;
    try {
      history = this.db
        ?.prepare('SELECT pane_id, assistant, cwd FROM session_history WHERE sid = ?')
        .get(item.sid) as typeof history;
    } catch {
      // main db unavailable / pre-migration — provenance stays file-derived
    }
    this.archive.upsertSession({
      sid: item.sid,
      assistant: history?.assistant ?? (item.kind === 'muxpad' ? null : 'claude'),
      cwd: meta.cwd ?? history?.cwd ?? null,
      pane_id: history?.pane_id ?? null,
      project_dir: item.projectDir ?? null,
      first_ts: meta.firstTs,
      last_ts: meta.lastTs,
    });
  }
}
