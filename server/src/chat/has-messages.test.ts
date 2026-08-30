// The gate that decides whether a pane may be CONVERTED (a different harness,
// a plain terminal, a web view). Conversion kills the runner and respawns, so a
// false "no messages here" destroys a real conversation. Every ambiguity in
// this probe must therefore resolve to "HAS messages".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentQueueStore } from '../store/AgentQueueStore.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { muxpadTranscriptDir, muxpadTranscriptPath } from './TranscriptReader.js';
import { agentPaneHasMessages } from './has-messages.js';

describe('agentPaneHasMessages', () => {
  let db: Database.Database;
  let paneId: string;
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    // The muxpad-format locator resolves under MUXPAD_DATA_DIR, so point it at
    // a temp dir — this test must never read or write the real ~/.muxpad.
    dataDir = mkdtempSync(join(tmpdir(), 'muxpad-hasmsg-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dataDir;
    db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'W' });
    const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws.id });
    paneId = new PaneStore(db).create({
      tab_id: tab.id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      startup_cmd: 'muxpad agent',
    }).id;
  });

  afterEach(() => {
    // Restoring an env var means the KEY must be absent again, not
    // present-and-undefined (which reads back as the string "undefined").
    // biome-ignore lint/performance/noDelete: see above
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Bind a codex-style session (muxpad-normalized log) and write `lines`. */
  function withTranscript(lines: string[]): void {
    const sid = 'sid-under-test';
    const sessions = new AgentSessionStore(db);
    sessions.register({ pane_id: paneId, assistant: 'codex', session_id: sid });
    mkdirSync(muxpadTranscriptDir(), { recursive: true });
    writeFileSync(muxpadTranscriptPath(sid), `${lines.join('\n')}\n`);
  }

  it('is false for a pane that never had a session', () => {
    expect(agentPaneHasMessages(db, paneId)).toBe(false);
  });

  it('is false for a started-but-silent session (metadata only)', () => {
    withTranscript([
      JSON.stringify({ id: 'a', kind: 'notice', text: 'session started' }),
      JSON.stringify({ id: 'b', kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: {} }),
    ]);
    expect(agentPaneHasMessages(db, paneId)).toBe(false);
  });

  it('is true once a user message exists', () => {
    withTranscript([JSON.stringify({ id: 'u1', kind: 'user', text: 'hello' })]);
    expect(agentPaneHasMessages(db, paneId)).toBe(true);
  });

  it('counts a QUEUED send as a message', () => {
    new AgentQueueStore(db).enqueue(paneId, 'run the thing');
    expect(agentPaneHasMessages(db, paneId)).toBe(true);
  });

  it('is true when the probe window does not cover the whole transcript', () => {
    // THE BUG. The probe reads a 256 KiB head window and drops the trailing
    // partial line. A single record can exceed that (a pasted file, a big tool
    // result) and metadata can push the first user turn past the boundary — so
    // "no user/assistant record in the window" is NOT "no messages", it's
    // "we could not tell". Unreadable already resolves to true; uncertain must
    // resolve the same way, because the cost of a false positive is a refused
    // conversion and the cost of a false negative is a destroyed conversation.
    const filler = JSON.stringify({
      id: 'big',
      kind: 'tool_result',
      toolUseId: 't1',
      text: 'x'.repeat(400 * 1024),
    });
    withTranscript([filler, JSON.stringify({ id: 'u1', kind: 'user', text: 'hello' })]);
    expect(agentPaneHasMessages(db, paneId)).toBe(true);
  });
});
