import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { openDb } from '../store/db.js';
import { ArchiveDb } from './ArchiveDb.js';
import { Archiver } from './Archiver.js';

/** One Claude-format transcript line (the fields the normalizer reads). */
function claudeLine(opts: {
  uuid: string;
  type: 'user' | 'assistant';
  text: string;
  ts?: string;
  cwd?: string;
  sidechain?: boolean;
}): string {
  const content = opts.type === 'assistant' ? [{ type: 'text', text: opts.text }] : opts.text;
  return `${JSON.stringify({
    uuid: opts.uuid,
    type: opts.type,
    timestamp: opts.ts ?? '2026-08-28T10:00:00.000Z',
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: { role: opts.type, content },
  })}\n`;
}

/** One muxpad-normalized log line (already a ChatEvent). */
function muxpadLine(opts: { id: string; kind: 'user' | 'assistant'; text: string }): string {
  return `${JSON.stringify({ kind: opts.kind, id: opts.id, ts: 1756375200000, text: opts.text })}\n`;
}

describe('Archiver', () => {
  let root: string;
  let projectsDir: string;
  let muxpadDir: string;
  let archiveDir: string;
  let archive: ArchiveDb;
  let archiver: Archiver;

  const newArchiver = (opts: Partial<ConstructorParameters<typeof Archiver>[0]> = {}) =>
    new Archiver({
      archive,
      archiveDir,
      claudeProjectsDir: projectsDir,
      muxpadTranscriptsDir: muxpadDir,
      ...opts,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muxpad-archiver-'));
    projectsDir = join(root, 'claude', 'projects');
    muxpadDir = join(root, 'data', 'agent-transcripts');
    archiveDir = join(root, 'data', 'archive');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(muxpadDir, { recursive: true });
    archive = new ArchiveDb(join(root, 'data', 'archive.sqlite'));
    archiver = newArchiver();
  });

  afterEach(() => {
    archiver.stop();
    archive.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('sweep mirrors claude top-level, subagent, and muxpad transcripts byte-for-byte', async () => {
    const proj = join(projectsDir, '-Users-me-proj');
    mkdirSync(join(proj, 'sid-main', 'subagents'), { recursive: true });
    const mainSrc =
      claudeLine({ uuid: 'u1', type: 'user', text: 'find the flaky test', cwd: '/Users/me/proj' }) +
      claudeLine({ uuid: 'a1', type: 'assistant', text: 'It lives in foo.spec.ts' });
    writeFileSync(join(proj, 'sid-main.jsonl'), mainSrc);
    const subSrc = claudeLine({
      uuid: 's1',
      type: 'assistant',
      text: 'subagent found the lodge rates',
      sidechain: true,
    });
    writeFileSync(join(proj, 'sid-main', 'subagents', 'agent-abc.jsonl'), subSrc);
    const muxSrc =
      muxpadLine({ id: 'm1', kind: 'user', text: 'codex hello' }) +
      muxpadLine({ id: 'm2', kind: 'assistant', text: 'codex reply CODEX-777' });
    writeFileSync(join(muxpadDir, 'sid-codex.jsonl'), muxSrc);

    await archiver.sweep();

    expect(readFileSync(join(archiveDir, 'sid-main.jsonl'), 'utf8')).toBe(mainSrc);
    expect(readFileSync(join(archiveDir, 'agent-abc.jsonl'), 'utf8')).toBe(subSrc);
    expect(readFileSync(join(archiveDir, 'sid-codex.jsonl'), 'utf8')).toBe(muxSrc);
    // Offsets recorded per source.
    const rows = archive.listFiles();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.indexed_offset).toBe(r.offset);
  });

  it('indexes normalized text — including subagent sidechain lines — searchably', async () => {
    const proj = join(projectsDir, '-p');
    mkdirSync(join(proj, 'sid-a', 'subagents'), { recursive: true });
    writeFileSync(
      join(proj, 'sid-a.jsonl'),
      claudeLine({ uuid: 'u1', type: 'user', text: 'please refactor the archiver' }),
    );
    writeFileSync(
      join(proj, 'sid-a', 'subagents', 'agent-x.jsonl'),
      claudeLine({
        uuid: 's1',
        type: 'assistant',
        text: 'sidechain zanzibar result',
        sidechain: true,
      }),
    );
    writeFileSync(
      join(muxpadDir, 'sid-b.jsonl'),
      muxpadLine({ id: 'm1', kind: 'assistant', text: 'muxpad xylophone answer' }),
    );
    await archiver.sweep();

    expect(archive.search('refactor').hits[0]?.sid).toBe('sid-a');
    expect(archive.search('refactor').hits[0]?.role).toBe('user');
    // Sidechain content indexes under the SUBAGENT's sid.
    expect(archive.search('zanzibar').hits[0]?.sid).toBe('agent-x');
    expect(archive.search('xylophone').hits[0]?.sid).toBe('sid-b');
    // Session metadata harvested from the transcript.
    expect(archive.getSession('sid-a')?.project_dir).toBe('-p');
  });

  it('appends incrementally from the recorded offset without duplicating', async () => {
    const proj = join(projectsDir, '-p');
    mkdirSync(proj, { recursive: true });
    const src = join(proj, 'sid-grow.jsonl');
    const l1 = claudeLine({ uuid: 'u1', type: 'user', text: 'first' });
    writeFileSync(src, l1);
    await archiver.sweep();
    const l2 = claudeLine({ uuid: 'a1', type: 'assistant', text: 'second' });
    appendFileSync(src, l2);
    await archiver.sweep();
    expect(readFileSync(join(archiveDir, 'sid-grow.jsonl'), 'utf8')).toBe(l1 + l2);
    expect(archive.search('second').hits).toHaveLength(1); // indexed exactly once
    expect(archive.search('first').hits).toHaveLength(1);
  });

  it('never mirrors a torn trailing line until its newline lands', async () => {
    const proj = join(projectsDir, '-p');
    mkdirSync(proj, { recursive: true });
    const src = join(proj, 'sid-torn.jsonl');
    const whole = claudeLine({ uuid: 'u1', type: 'user', text: 'complete' });
    const partial = '{"uuid":"u2","type":"user","message":{"role":"user","content":"tor';
    writeFileSync(src, whole + partial);
    await archiver.sweep();
    expect(readFileSync(join(archiveDir, 'sid-torn.jsonl'), 'utf8')).toBe(whole);
    expect(archive.getFile(src)?.offset).toBe(Buffer.byteLength(whole));
    // The newline lands → the rest of the line is mirrored.
    appendFileSync(src, 'n here"}}\n');
    await archiver.sweep();
    expect(readFileSync(join(archiveDir, 'sid-torn.jsonl'), 'utf8')).toBe(
      `${whole + partial}n here"}}\n`,
    );
  });

  it('copies a line bigger than the read chunk intact', async () => {
    const proj = join(projectsDir, '-p');
    mkdirSync(proj, { recursive: true });
    const src = join(proj, 'sid-big.jsonl');
    const big = claudeLine({ uuid: 'u1', type: 'user', text: 'x'.repeat(64 * 1024) });
    writeFileSync(src, big);
    archiver.stop();
    archiver = newArchiver({ chunkBytes: 4096 }); // force many chunks per line
    await archiver.sweep();
    expect(readFileSync(join(archiveDir, 'sid-big.jsonl'), 'utf8')).toBe(big);
  });

  it('seals a shrunken source as <sid>.v1.jsonl and starts a fresh copy', async () => {
    const proj = join(projectsDir, '-p');
    mkdirSync(proj, { recursive: true });
    const src = join(proj, 'sid-c.jsonl');
    const before =
      claudeLine({ uuid: 'u1', type: 'user', text: 'the pre-compact conversation' }) +
      claudeLine({ uuid: 'a1', type: 'assistant', text: 'long answer here' });
    writeFileSync(src, before);
    await archiver.sweep();
    // Compact rewrite: file replaced with a shorter summary.
    const after = claudeLine({ uuid: 'z1', type: 'user', text: 'post-compact summary' });
    writeFileSync(src, after);
    await archiver.sweep();
    // Sealed version holds the FULL pre-compact copy; active holds the fresh one.
    expect(readFileSync(join(archiveDir, 'sid-c.v1.jsonl'), 'utf8')).toBe(before);
    expect(readFileSync(join(archiveDir, 'sid-c.jsonl'), 'utf8')).toBe(after);
    const row = archive.getFile(src);
    expect(row?.version).toBe(1);
    expect(row?.offset).toBe(Buffer.byteLength(after));
    // Both eras stay searchable.
    expect(archive.search('"pre-compact"').hits).toHaveLength(1);
    expect(archive.search('"post-compact"').hits).toHaveLength(1);
  });

  it('a vanished source with a fully-copied archive is fine, not an error', async () => {
    // migrateTranscript deletes its source after concatenating into the new
    // sid's file — the archived copy must simply stand.
    const src = join(muxpadDir, 'sid-old.jsonl');
    const content = muxpadLine({ id: 'm1', kind: 'user', text: 'pre-migrate history' });
    writeFileSync(src, content);
    await archiver.sweep();
    rmSync(src);
    await expect(archiver.sweep()).resolves.toBeUndefined();
    expect(readFileSync(join(archiveDir, 'sid-old.jsonl'), 'utf8')).toBe(content);
    expect(archive.search('"pre-migrate"').hits).toHaveLength(1);
  });

  it('offsets resume across an archiver (process) restart', async () => {
    const proj = join(projectsDir, '-p');
    mkdirSync(proj, { recursive: true });
    const src = join(proj, 'sid-r.jsonl');
    const l1 = claudeLine({ uuid: 'u1', type: 'user', text: 'before restart' });
    writeFileSync(src, l1);
    await archiver.sweep();
    archiver.stop();
    // "Restart": a fresh Archiver over the same archive DB + dirs.
    archiver = newArchiver();
    const l2 = claudeLine({ uuid: 'a1', type: 'assistant', text: 'after restart' });
    appendFileSync(src, l2);
    await archiver.sweep();
    expect(readFileSync(join(archiveDir, 'sid-r.jsonl'), 'utf8')).toBe(l1 + l2);
    expect(archive.search('"before restart"').hits).toHaveLength(1);
    expect(archive.search('"after restart"').hits).toHaveLength(1);
  });

  it('agent_turn done on the bus triggers a near-realtime archive of that sid', async () => {
    const events = new EventBus();
    archiver.stop();
    archiver = newArchiver({ events, sweepIntervalMs: 60 * 60_000 });
    archiver.start(); // boot sweep over (still-empty) dirs + bus subscription
    await archiver.idle();
    const proj = join(projectsDir, '-p');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 'sid-t.jsonl'),
      claudeLine({ uuid: 'u1', type: 'user', text: 'turn trigger quokka' }),
    );
    events.emit({
      type: 'agent_turn',
      pane_id: 'p1',
      phase: 'done',
      sid: 'sid-t',
      backend: 'claude',
    });
    await archiver.idle();
    expect(archive.search('quokka').hits).toHaveLength(1);
  });

  it('an empty sweep does not brick the archiver (drain-poisoning regression)', async () => {
    // The drain loop once left a permanently-settled promise in its slot when
    // the queue was empty — every later drain() short-circuited on it and
    // nothing was ever archived again. Empty sweep first, then real work.
    await archiver.sweep(); // both trees empty — nothing to do
    await archiver.sweep(); // twice, for good measure
    writeFileSync(
      join(muxpadDir, 'sid-late.jsonl'),
      muxpadLine({ id: 'm1', kind: 'user', text: 'late arrival numbat' }),
    );
    await archiver.sweep();
    expect(archive.listFiles()).toHaveLength(1);
    expect(archive.search('numbat').hits).toHaveLength(1);
    expect(readFileSync(join(archiveDir, 'sid-late.jsonl'), 'utf8')).toContain('numbat');
  });

  it('detects a grow-rewrite (migrateTranscript prepend) and seals + recopies from 0', async () => {
    // migrateTranscript concatenates OLD history ++ existing into the new
    // sid's file: the file GROWS but the already-mirrored region shifts. A
    // blind append from the stale offset would interleave old and new lines.
    const src = join(muxpadDir, 'sid-mig.jsonl');
    const newLine = muxpadLine({ id: 'n1', kind: 'user', text: 'new-era gerenuk' });
    writeFileSync(src, newLine);
    await archiver.sweep(); // mirror = newLine
    const oldHistory =
      muxpadLine({ id: 'o1', kind: 'user', text: 'old-era dikdik one' }) +
      muxpadLine({ id: 'o2', kind: 'user', text: 'old-era dikdik two' });
    writeFileSync(src, oldHistory + newLine); // the migrate concat
    await archiver.sweep();
    // Fresh copy is byte-identical to the concatenated source…
    expect(readFileSync(join(archiveDir, 'sid-mig.jsonl'), 'utf8')).toBe(oldHistory + newLine);
    // …the pre-rewrite mirror is sealed, and nothing was lost or interleaved.
    expect(readFileSync(join(archiveDir, 'sid-mig.v1.jsonl'), 'utf8')).toBe(newLine);
    expect(archive.getFile(src)?.version).toBe(1);
    expect(archive.search('"dikdik one"').hits).toHaveLength(1);
  });

  it('rejects queries over the byte cap instead of evaluating them', () => {
    expect(() => archive.search('x '.repeat(5_000))).toThrow(RangeError);
  });

  it('a sid change on agent_session.updated enqueues both sids (old is best-effort)', async () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, position, created_at, updated_at)
       VALUES ('w1', 'w', 'w', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at)
       VALUES ('t1', 't', 't', '', 'w1', 0, 0, 0)`,
    ).run();
    db.prepare(
      "INSERT INTO panes (id, tab_id, shell, cwd, created_at) VALUES ('p1','t1','/bin/sh','/tmp',0)",
    ).run();
    db.prepare(
      `INSERT INTO agent_sessions (id, pane_id, assistant, current_sid, lineage, created_at, updated_at)
       VALUES ('as1', 'p1', 'codex', 'sid-old', '["sid-old"]', 0, 0)`,
    ).run();
    const events = new EventBus();
    archiver.stop();
    archiver = newArchiver({ events, db, sweepIntervalMs: 60 * 60_000 });
    archiver.start();
    await archiver.idle();
    // First update just teaches the archiver the current sid.
    events.emit({ type: 'agent_session.updated', pane_id: 'p1' });
    await archiver.idle();
    // A resume re-mints the id. In reality migrateTranscript has ALREADY run
    // in the runner process by the time the server hears about the change:
    // the old sid's file is gone (its history concatenated into the new
    // sid's file). The old-sid enqueue must no-op on the missing file, and
    // the NEW sid's file — old history included — is what gets mirrored.
    writeFileSync(
      join(muxpadDir, 'sid-new.jsonl'),
      muxpadLine({ id: 'm1', kind: 'user', text: 'remint wallaby history' }) +
        muxpadLine({ id: 'm2', kind: 'user', text: 'post-remint reply' }),
    );
    db.prepare("UPDATE agent_sessions SET current_sid = 'sid-new' WHERE pane_id = 'p1'").run();
    events.emit({ type: 'agent_session.updated', pane_id: 'p1' });
    await archiver.idle();
    expect(readFileSync(join(archiveDir, 'sid-new.jsonl'), 'utf8')).toContain('wallaby');
    expect(archive.search('wallaby').hits[0]?.sid).toBe('sid-new');
    // The vanished old sid produced no row and no error.
    expect(archive.getFile(join(muxpadDir, 'sid-old.jsonl'))).toBeNull();
  });

  it('enriches archive_sessions from session_history when the main db is present', async () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen)
       VALUES ('sid-e', 'pane-9', 'codex', '/work/dir', 1, 2)`,
    ).run();
    archiver.stop();
    archiver = newArchiver({ db });
    writeFileSync(
      join(muxpadDir, 'sid-e.jsonl'),
      muxpadLine({ id: 'm1', kind: 'user', text: 'enrich me' }),
    );
    await archiver.sweep();
    const sess = archive.getSession('sid-e');
    expect(sess?.assistant).toBe('codex');
    expect(sess?.pane_id).toBe('pane-9');
    expect(sess?.cwd).toBe('/work/dir');
  });

  it('search falls back to a quoted phrase on FTS5 syntax errors', () => {
    archive.insertMessages([
      { text: 'weird AND OR "unbalanced query text', sid: 's', ts: 1, role: 'user' },
    ]);
    // Raw `"unbalanced` is an FTS5 syntax error — must not throw.
    const res = archive.search('"unbalanced query');
    expect(res.fallback).toBe(true);
    expect(res.hits).toHaveLength(1);
  });
});
