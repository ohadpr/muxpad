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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveDb } from '../archive/ArchiveDb.js';
import { Archiver } from '../archive/Archiver.js';
import { projectsDir } from '../chat/TranscriptReader.js';
import { EventBus } from '../events.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * Isolated-instance e2e for the session archive: a sandboxed data dir +
 * CLAUDE_CONFIG_DIR pointed at a fixture tree (NEVER the real ~/.claude or
 * ~/.muxpad), booted the way index.ts boots — ArchiveDb + Archiver + the HTTP
 * app — then exercised through the real /api/search and /api/archive routes.
 */

function claudeLine(uuid: string, type: 'user' | 'assistant', text: string, extra = {}): string {
  const content = type === 'assistant' ? [{ type: 'text', text }] : text;
  return `${JSON.stringify({
    uuid,
    type,
    timestamp: '2026-08-28T12:00:00.000Z',
    cwd: '/Users/me/proj',
    ...extra,
    message: { role: type, content },
  })}\n`;
}

describe('session archive e2e (isolated instance)', () => {
  let root: string; // sandboxed "data dir" + fixture CLAUDE_CONFIG_DIR
  let dataDir: string;
  let claudeConfigDir: string;
  let db: ReturnType<typeof openDb>;
  let archiveDb: ArchiveDb;
  let archiver: Archiver;
  let events: EventBus;
  let testApp: TestApp;

  /** Boot the archive stack the way index.ts does (from the same data dir). */
  async function boot(): Promise<void> {
    db = openDb(join(dataDir, 'db.sqlite'));
    events = new EventBus();
    archiveDb = new ArchiveDb(join(dataDir, 'archive.sqlite'));
    archiver = new Archiver({
      archive: archiveDb,
      archiveDir: join(dataDir, 'archive'),
      // Resolved via CLAUDE_CONFIG_DIR — the same resolution index.ts uses.
      claudeProjectsDir: projectsDir(),
      muxpadTranscriptsDir: join(dataDir, 'agent-transcripts'),
      db,
      events,
    });
    testApp = await createTestApp({ db, dataDir, events, archive: archiveDb });
  }

  async function shutdown(): Promise<void> {
    archiver.stop();
    await testApp.cleanup();
    archiveDb.close();
    db.close();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muxpad-archive-e2e-'));
    dataDir = join(root, 'data');
    claudeConfigDir = join(root, 'claude-config');
    mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);

    // Fixture transcripts: a Claude session + a subagent sidechain under the
    // fake projects tree, and a muxpad-owned normalized log.
    const proj = join(claudeConfigDir, 'projects', '-Users-me-proj');
    mkdirSync(join(proj, 'sid-claude', 'subagents'), { recursive: true });
    writeFileSync(
      join(proj, 'sid-claude.jsonl'),
      claudeLine('u1', 'user', 'where does the aardvark index live?') +
        claudeLine('a1', 'assistant', 'The aardvark index lives in archive.sqlite'),
    );
    writeFileSync(
      join(proj, 'sid-claude', 'subagents', 'agent-sub1.jsonl'),
      claudeLine('s1', 'assistant', 'subagent found the pangolin config', { isSidechain: true }),
    );
    mkdirSync(join(dataDir, 'agent-transcripts'), { recursive: true });
    writeFileSync(
      join(dataDir, 'agent-transcripts', 'sid-codex.jsonl'),
      `${JSON.stringify({ kind: 'assistant', id: 'm1', ts: 1756382400000, text: 'codex says capybara' })}\n`,
    );
  });

  afterEach(async () => {
    await shutdown();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('boot sweep archives all fixtures; search + sessions APIs serve them; shrink seals; offsets survive restart', async () => {
    await boot();
    await archiver.sweep(); // the boot sweep, awaited so assertions can follow

    // ── 1. sweep archived all three sources, byte-for-byte ──────────────────
    const archiveDir = join(dataDir, 'archive');
    const proj = join(claudeConfigDir, 'projects', '-Users-me-proj');
    expect(readFileSync(join(archiveDir, 'sid-claude.jsonl'), 'utf8')).toBe(
      readFileSync(join(proj, 'sid-claude.jsonl'), 'utf8'),
    );
    expect(readFileSync(join(archiveDir, 'agent-sub1.jsonl'), 'utf8')).toBe(
      readFileSync(join(proj, 'sid-claude', 'subagents', 'agent-sub1.jsonl'), 'utf8'),
    );
    expect(readFileSync(join(archiveDir, 'sid-codex.jsonl'), 'utf8')).toBe(
      readFileSync(join(dataDir, 'agent-transcripts', 'sid-codex.jsonl'), 'utf8'),
    );

    // ── 2. GET /api/search returns hits with correct sids + snippets ────────
    const app = testApp.app;
    let res = await app.request('/api/search?q=aardvark');
    expect(res.status).toBe(200);
    let body = (await res.json()) as {
      fallback: boolean;
      hits: Array<{ sid: string; role: string; snippet: string; session: { cwd: string | null } }>;
    };
    expect(body.fallback).toBe(false);
    expect(body.hits.length).toBe(2); // user question + assistant answer
    expect(body.hits.every((h) => h.sid === 'sid-claude')).toBe(true);
    expect(body.hits[0]?.snippet).toContain('«aardvark»');
    expect(body.hits[0]?.session.cwd).toBe('/Users/me/proj');

    // role filter narrows to the assistant hit
    res = await app.request('/api/search?q=aardvark&role=assistant');
    body = (await res.json()) as typeof body;
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]?.role).toBe('assistant');

    // subagent + muxpad content are searchable under their own sids
    res = await app.request('/api/search?q=pangolin');
    body = (await res.json()) as typeof body;
    expect(body.hits[0]?.sid).toBe('agent-sub1');
    res = await app.request('/api/search?q=capybara');
    body = (await res.json()) as typeof body;
    expect(body.hits[0]?.sid).toBe('sid-codex');

    // a broken FTS5 expression falls back to a phrase match, not a 500
    res = await app.request(`/api/search?q=${encodeURIComponent('"aardvark index')}`);
    expect(res.status).toBe(200);
    body = (await res.json()) as typeof body;
    expect(body.fallback).toBe(true);
    expect(body.hits.length).toBeGreaterThan(0);

    // an over-cap q is rejected with 400 up front, never evaluated (a huge
    // MATCH expression would freeze the main thread)
    res = await app.request(`/api/search?q=${encodeURIComponent('x '.repeat(2000))}`);
    expect(res.status).toBe(400);

    // ── 3. GET /api/archive/sessions lists all three sessions ───────────────
    res = await app.request('/api/archive/sessions');
    expect(res.status).toBe(200);
    const sessions = (
      (await res.json()) as {
        sessions: Array<{ sid: string; cwd: string | null; project_dir: string | null }>;
      }
    ).sessions;
    const sids = sessions.map((s) => s.sid).sort();
    expect(sids).toEqual(['agent-sub1', 'sid-claude', 'sid-codex']);
    const claudeSess = sessions.find((s) => s.sid === 'sid-claude');
    expect(claudeSess?.cwd).toBe('/Users/me/proj');
    expect(claudeSess?.project_dir).toBe('-Users-me-proj');
    // cwd filter
    res = await app.request('/api/archive/sessions?cwd=me%2Fproj');
    expect(((await res.json()) as { sessions: unknown[] }).sessions.length).toBe(2);

    // ── 4. shrink → sealed version + fresh copy ─────────────────────────────
    const srcPath = join(proj, 'sid-claude.jsonl');
    const preCompact = readFileSync(srcPath, 'utf8');
    const compacted = claudeLine('c1', 'user', 'compact summary of the ferret work');
    writeFileSync(srcPath, compacted); // rewrite shorter, from byte 0
    await archiver.sweep();
    expect(readFileSync(join(archiveDir, 'sid-claude.v1.jsonl'), 'utf8')).toBe(preCompact);
    expect(readFileSync(join(archiveDir, 'sid-claude.jsonl'), 'utf8')).toBe(compacted);
    res = await app.request('/api/search?q=ferret');
    body = (await res.json()) as typeof body;
    expect(body.hits[0]?.sid).toBe('sid-claude');

    // ── 5. offsets resume across a server restart ───────────────────────────
    const offsetBefore = archiveDb.getFile(srcPath)?.offset;
    expect(offsetBefore).toBe(Buffer.byteLength(compacted));
    await shutdown();
    await boot(); // fresh process state over the same data dir
    appendFileSync(srcPath, claudeLine('c2', 'assistant', 'post-restart ocelot reply'));
    await archiver.sweep();
    // Resumed from the recorded offset: no duplication, new line appended.
    expect(readFileSync(join(archiveDir, 'sid-claude.jsonl'), 'utf8')).toBe(
      readFileSync(srcPath, 'utf8'),
    );
    expect(archiveDb.getFile(srcPath)?.version).toBe(1); // seal state survived
    res = await testApp.app.request('/api/search?q=ocelot');
    body = (await res.json()) as typeof body;
    expect(body.hits).toHaveLength(1);
    // …and the pre-restart index wasn't re-ingested (still exactly one
    // 'ferret' hit, not two).
    res = await testApp.app.request('/api/search?q=ferret');
    body = (await res.json()) as typeof body;
    expect(body.hits).toHaveLength(1);
  }, 20_000);
});
