# Session archive — store every agent session forever, searchable

**Date:** 2026-08-28
**Status:** Design.
**Goal:** muxpad permanently owns a copy of every agent session transcript and
can search across all of them.

## Why muxpad can't just rely on what exists

- Claude transcripts (`~/.claude/projects/**/<sid>.jsonl`) are written and
  **owned by Claude Code, which reaps them on a ~30-day window** (empirically
  confirmed; mitigated 2026-08-28 by `cleanupPeriodDays: 36500` in
  `~/.claude/settings.json`, but muxpad should not depend on a foreign tool's
  retention setting). muxpad only ever tail-reads them in place.
- Codex/cursor transcripts (`~/.muxpad/agent-transcripts/`) are already
  muxpad-owned and never pruned — but `migrateTranscript` deletes the old
  file on id re-mint, and nothing indexes any of it.
- `agent_sessions` is a live table: one row per pane, `lineage` reset on
  fresh launch, row cascade-deleted with the pane. **The pane↔sid history is
  being lost even where the transcript survives.**
- Bridged (claude.ai) sessions produce no local JSONL — out of scope; noted
  as a known gap.

## Design

Three pieces, all in the main server.

### 1. `session_history` — append-only session registry (main DB, migration 20)

```sql
CREATE TABLE session_history (
  sid        TEXT PRIMARY KEY,
  pane_id    TEXT,            -- no FK: must survive pane deletion
  assistant  TEXT,
  cwd        TEXT,
  first_seen INTEGER,
  last_seen  INTEGER
);
```

Written from every place a sid becomes known (`recordSessionId`, `register`,
`attachRunner` in `AgentSessionStore`), upsert on sid, never deleted. This
fixes the lineage-reset and cascade-delete losses independently of archiving.

### 2. Archiver — raw mirrors + incremental copy

- Storage: `~/.muxpad/archive/<sid>.jsonl` — **raw lines, byte-for-byte**.
  The normalized ChatEvent shape is materially lossy (drops sidechains, meta,
  usage, system records); archive fidelity means raw.
- Offsets tracked per source file in the archive DB; copy is append-only from
  the last offset (reuse `TranscriptTail`'s byte-offset discipline, but sink
  raw bytes — a sibling reader or an `onRawLines` hook, not the normalizing
  emit path).
- **Shrink/compact handling**: if a source file shrinks (compact rewrite),
  seal the current archive file as `<sid>.v<N>.jsonl` and start a fresh copy
  from byte 0. Nothing is ever overwritten or lost.
- Triggers:
  - `agent_turn` phase=done on the in-process bus (sid + transcript path are
    resolvable right there — same cascade as `routes/agent-sessions.ts:152`).
  - sid change in `syncSession`.
  - **Sweep**: at boot and every 15 min, scan `~/.claude/projects` (top-level
    AND `subagents/*.jsonl`) and `~/.muxpad/agent-transcripts` for files that
    are new or have grown vs recorded offsets. The sweep is what makes it
    "all sessions" — including TUI `muxpad claude` panes and Claude sessions
    started outside muxpad entirely. Turn-done just makes muxpad-driven
    sessions near-realtime.
- Backfill = the first sweep: ~600 files / ~600 MB copied once, incremental
  after that.

### 3. Search — FTS5 in a separate `~/.muxpad/archive.sqlite`

Separate DB file, not the 192 KB operational `db.sqlite`: the archive index
will dwarf it and FTS churn shouldn't share the WAL the UI reads. Same
better-sqlite3 driver (FTS5 verified available).

```sql
CREATE TABLE archive_files (source_path, sid, archived_path, offset, mtime, size, indexed_offset);
CREATE TABLE archive_sessions (sid PRIMARY KEY, assistant, cwd, pane_id, project_dir, first_ts, last_ts);
CREATE VIRTUAL TABLE messages USING fts5(text, sid UNINDEXED, ts UNINDEXED, role UNINDEXED);
```

- Indexing: as bytes are archived, parse + normalize each complete line
  (`normalizeTranscriptLine` — lossy is *correct* here; the index is for
  finding, the raw file is for reading) and insert text rows. Indexed offset
  tracked separately from copy offset so indexing can lag/retry.
- API: `GET /api/search?q=<fts5 query>&limit=&sid=&role=` → hits with sid,
  ts, role, snippet (FTS5 `snippet()`), plus session metadata joined from
  `archive_sessions` and `session_history`.
- `GET /api/archive/sessions` — browse: sessions sorted by last_ts with
  cwd/assistant/pane provenance.
- CLI: `muxpad search "query" [--limit=N] [--json]` and
  `muxpad search --sessions [--cwd=<filter>]`.
- UI: deferred. CLI/API first; the CEO pane can use `muxpad search` today.

## Non-goals

- Bridged claude.ai sessions (no local file exists — nothing to archive).
- Codex native rollouts in `~/.codex/sessions` (muxpad's own normalized log
  already covers those sessions).
- Retention/pruning policy: the answer is "forever" by definition. At
  ~320 MB/month raw, a year is ~4 GB — fine on disk; FTS index adds ~30-50%.
- Vector/semantic search — FTS5 keyword+phrase is the v1; embeddings later
  if wanted.

## Rollout

Main-server restart only. First sweep runs in the background at boot
(throttled reads); no ptyd involvement anywhere.
