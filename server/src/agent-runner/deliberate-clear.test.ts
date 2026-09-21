// A CONVERSATION YOU CLEARED ON PURPOSE MUST STAY CLEARED.
//
// `/clear` rotates the session id: the CLI starts a new conversation, the
// runner sees the drift on the next `init`, and hellos so the server re-points
// `current_sid` and `startup_cmd` at the new, deliberately-empty session.
//
// Which is indistinguishable, on disk, from the drift the resume repair exists
// to undo. Both look like "the pane points at a sid with no transcript, and an
// older sid of the same pane has one" — so a restart before the next message
// walked `session_history`, found the PRE-clear conversation, and wrote it back
// into `current_sid` and the startup command. The chat you emptied comes back,
// with its context and its cost, announced by a push calling it a recovery.
//
// Nothing on the filesystem can tell the two apart, because the difference is
// INTENT and it exists for exactly one instant: the moment the user asks for
// the clear. So that is where it is recorded — a mark on the new sid, next to
// the one that says a session has taken a turn (session-marks.ts) — and the
// repair reads it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => import('../test-helpers/fakeAgentSdk.js'));

import { planResumeRepair } from '../agent-resume-repair.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { fakeSession, resetFakeAgentSdk } from '../test-helpers/fakeAgentSdk.js';
import { sdk } from '../test-helpers/sdkScript.js';
import { createClaudeBackend } from './backends/claude.js';
import type { RunnerHost } from './backends/types.js';
import { markSessionCleared, sessionWasCleared } from './session-marks.js';

const BOOT_SID = '11111111-2222-3333-4444-555555555555';
const AFTER_CLEAR = '99999999-8888-7777-6666-555555555555';
const OLD_WITH_HISTORY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let tmp: string;
let prevDataDir: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'muxpad-clear-'));
  prevDataDir = process.env.MUXPAD_DATA_DIR;
  process.env.MUXPAD_DATA_DIR = tmp;
});
afterEach(() => {
  resetFakeAgentSdk();
  // biome-ignore lint/performance/noDelete: restoring the env var
  if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
  else process.env.MUXPAD_DATA_DIR = prevDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

/** The backend on its own, booted on a known sid so the first init is a no-op. */
function boot() {
  const sent: unknown[] = [];
  const host: RunnerHost = {
    emit: (f) => void sent.push(f),
    log: () => {},
    connected: () => true,
    paneId: 'pane-1',
    apiUrl: 'http://127.0.0.1:1',
  };
  const backend = createClaudeBackend(host, {
    requestedSid: BOOT_SID,
    requestedModel: null,
    mode: 'chat',
  });
  const session = fakeSession();
  const loop = backend.start().catch(() => {});
  return {
    backend,
    async feed(messages: unknown[]) {
      for (const m of messages) session.push(m);
      await session.settle();
      await new Promise((r) => setTimeout(r, 10));
    },
    async stop() {
      session.end();
      await new Promise((r) => setTimeout(r, 10));
      await loop;
    },
  };
}

describe('the runner records that a rotation was ASKED FOR', () => {
  it('marks the session /clear started', async () => {
    const fx = boot();
    await fx.feed([sdk.init(BOOT_SID)]);
    fx.backend.slash('clear');
    await new Promise((r) => setTimeout(r, 10));
    // The CLI answers a clear by re-initialising under a new id.
    await fx.feed([sdk.init(AFTER_CLEAR), sdk.result('success')]);
    expect(sessionWasCleared(AFTER_CLEAR)).toBe(true);
    // …and the id it left behind is not marked: that one HAS the history.
    expect(sessionWasCleared(BOOT_SID)).toBe(false);
    await fx.stop();
  });

  it('does NOT mark a drift nobody asked for — that is the one to repair', async () => {
    // A resume that re-mints its id, or a stray `muxpad agent` minting a
    // session in an occupied pane: same rotation, opposite meaning.
    const fx = boot();
    await fx.feed([sdk.init(BOOT_SID)]);
    await fx.feed([sdk.init(AFTER_CLEAR)]);
    expect(sessionWasCleared(AFTER_CLEAR)).toBe(false);
    await fx.stop();
  });

  it('does not leak the intent onto a LATER rotation', async () => {
    const fx = boot();
    await fx.feed([sdk.init(BOOT_SID)]);
    fx.backend.slash('clear');
    await new Promise((r) => setTimeout(r, 10));
    await fx.feed([sdk.init(AFTER_CLEAR), sdk.result('success')]);
    // An ordinary message, then a rotation with no clear behind it.
    fx.backend.send('carry on');
    await new Promise((r) => setTimeout(r, 10));
    const later = '77777777-7777-7777-7777-777777777777';
    await fx.feed([sdk.init(later), sdk.result('success')]);
    expect(sessionWasCleared(later)).toBe(false);
    await fx.stop();
  });
});

describe('the repair leaves a deliberately-cleared pane alone', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  /** A pane pointing at an empty session, with an older one that has history. */
  function pane(): string {
    const workspaces = new WorkspaceStore(db);
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const ws = workspaces.create({ name: 'W' });
    const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id });
    const p = panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/Users/ohadpr' });
    new AgentSessionStore(db).attachRunner({
      pane_id: p.id,
      cwd: '/Users/ohadpr',
      assistant: 'claude',
    });
    for (const [sid, seen] of [
      [OLD_WITH_HISTORY, 1_000],
      [AFTER_CLEAR, 2_000],
    ] as const) {
      db.prepare(
        `INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen)
         VALUES (?, ?, 'claude', '/Users/ohadpr', ?, ?)`,
      ).run(sid, p.id, seen, seen);
    }
    db.prepare('UPDATE agent_sessions SET current_sid = ? WHERE pane_id = ?').run(
      AFTER_CLEAR,
      p.id,
    );
    return p.id;
  }

  /** Only the pre-clear session has a transcript — the shape of both cases. */
  const locate = (sid: string) => (sid === OLD_WITH_HISTORY ? `/transcripts/${sid}.jsonl` : null);

  it('repairs an UNMARKED empty target, exactly as before', async () => {
    const paneId = pane();
    expect(planResumeRepair(db, paneId, { locate })).toMatchObject({
      from: AFTER_CLEAR,
      to: OLD_WITH_HISTORY,
    });
  });

  it('but not one the user emptied on purpose', async () => {
    const paneId = pane();
    markSessionCleared(AFTER_CLEAR);
    expect(planResumeRepair(db, paneId, { locate })).toBeNull();
  });
});
