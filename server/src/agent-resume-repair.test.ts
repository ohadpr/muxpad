// The stranded-conversation repair, driven against the SHAPE OF THE REAL
// INCIDENT: pane 01M2R8RT874AC74YR6899FH2ZG carried four session ids over three
// days, `agent_sessions.current_sid` pointed at the one that never wrote a
// transcript, and the 1,788-event conversation sat on disk under an older one.
//
// Both transcript stores are real here — `<MUXPAD_DATA_DIR>/agent-transcripts`
// for codex/cursor and `$CLAUDE_CONFIG_DIR/projects/<cwd>/<sid>.jsonl` for
// Claude — because "we only looked in one of them" is precisely the class of
// miss this module exists to stop.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeRepair,
  locateAnyTranscript,
  planResumeRepair,
  repairAllResumeTargets,
  repairPaneResume,
  rewriteResumeCmd,
} from './agent-resume-repair.js';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PaneNotifyOutcome } from './push.js';
import { AgentSessionStore } from './store/AgentSessionStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { attachWsServer } from './ws.js';

let tmp: string;
let db: Database.Database;
let prevDataDir: string | undefined;
let prevClaudeDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'muxpad-resume-repair-'));
  prevDataDir = process.env.MUXPAD_DATA_DIR;
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.MUXPAD_DATA_DIR = join(tmp, 'data');
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  db = openDb(':memory:');
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: restoring env vars
  if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
  else process.env.MUXPAD_DATA_DIR = prevDataDir;
  // biome-ignore lint/performance/noDelete: restoring env vars
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A codex/cursor transcript: `<dataDir>/agent-transcripts/<sid>.jsonl`. */
function writeMuxpadTranscript(sid: string): void {
  const dir = join(tmp, 'data', 'agent-transcripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sid}.jsonl`),
    `${JSON.stringify({ kind: 'user', id: 'u1', ts: 1, text: 'hello' })}\n`,
  );
}

/** A Claude transcript: `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<sid>.jsonl`. */
function writeClaudeTranscript(sid: string): void {
  const dir = join(tmp, 'claude', 'projects', '-Users-ohadpr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), '{"type":"user"}\n');
}

interface Fixture {
  paneId: string;
  /** Append a row to the registry exactly as `recordHistory` would. */
  history(sid: string, assistant: string, lastSeen: number): void;
  /** Point `agent_sessions` at a sid (and record the lineage, as the real path does). */
  pointAt(sid: string, lineage: string[]): void;
  session(): { current_sid: string | null; lineage: string; assistant: string };
  startupCmd(): string | null;
}

function fixture(startup_cmd = 'muxpad agent --backend codex --model gpt-6-astra'): Fixture {
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const ws = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/Users/ohadpr', startup_cmd });
  const agents = new AgentSessionStore(db);
  agents.attachRunner({ pane_id: pane.id, cwd: '/Users/ohadpr', assistant: 'codex' });
  return {
    paneId: pane.id,
    history(sid, assistant, lastSeen) {
      db.prepare(
        `INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen)
         VALUES (?, ?, ?, '/Users/ohadpr', ?, ?)
         ON CONFLICT(sid) DO UPDATE SET last_seen = excluded.last_seen`,
      ).run(sid, pane.id, assistant, lastSeen, lastSeen);
    },
    pointAt(sid, lineage) {
      db.prepare('UPDATE agent_sessions SET current_sid = ?, lineage = ? WHERE pane_id = ?').run(
        sid,
        JSON.stringify(lineage),
        pane.id,
      );
    },
    session() {
      return db
        .prepare('SELECT current_sid, lineage, assistant FROM agent_sessions WHERE pane_id = ?')
        .get(pane.id) as { current_sid: string | null; lineage: string; assistant: string };
    },
    startupCmd() {
      return (
        db.prepare('SELECT startup_cmd FROM panes WHERE id = ?').get(pane.id) as {
          startup_cmd: string | null;
        }
      ).startup_cmd;
    },
  };
}

// The four ids the real pane carried, in the order its log shows them.
const CLAUDE_FIRST = 'fc05a0b1-e6f8-48a1-a631-df20fc5c7d00';
const CODEX_EARLY = '350e3c91-6065-4b84-87a6-129d305487f9';
const CODEX_REAL = '01a0b091-3504-7e43-b07c-f7f4c913dad8'; // the one with the history
const DRIFTED = '8a2c3628-cd9a-4248-81bc-e6f5606f0270'; // what the DB pointed at

/** The incident, reconstructed: four sids, a transcript on exactly one. */
function realIncident(): Fixture {
  const f = fixture('muxpad agent --model gpt-6-astra --resume 8a2c3628-cd9a-4248-81bc-e6f5606f0270');
  f.history(CLAUDE_FIRST, 'claude', 1_789_668_387_562);
  f.history(CODEX_EARLY, 'codex', 1_789_668_416_399);
  f.history(CODEX_REAL, 'codex', 1_789_926_633_029);
  f.history(DRIFTED, 'claude', 1_789_927_378_063); // newest, and empty
  f.pointAt(DRIFTED, [CLAUDE_FIRST, CODEX_EARLY, CODEX_REAL, DRIFTED]);
  writeMuxpadTranscript(CODEX_REAL);
  return f;
}

describe('planResumeRepair', () => {
  it('recovers the most recent sid that has a transcript', () => {
    const f = realIncident();
    const plan = planResumeRepair(db, f.paneId);
    expect(plan).not.toBeNull();
    expect(plan?.from).toBe(DRIFTED);
    expect(plan?.to).toBe(CODEX_REAL);
    expect(plan?.assistant).toBe('codex');
    expect(plan?.candidates).toBe(1);
  });

  it('leaves a healthy resume target alone', () => {
    const f = realIncident();
    writeMuxpadTranscript(DRIFTED); // the target is fine after all
    expect(planResumeRepair(db, f.paneId)).toBeNull();
  });

  it('says nothing about a pane that never had a conversation', () => {
    // The sibling pane in the same tab: one sid, 29 log lines, zero user turns.
    const f = fixture('muxpad agent --backend codex');
    const only = '79bf6193-867f-44aa-bd76-79128525f799';
    f.history(only, 'codex', 1_789_927_378_049);
    f.pointAt(only, [only]);
    expect(planResumeRepair(db, f.paneId)).toBeNull();
    // …and a repair pass over it writes NOTHING.
    const before = { ...f.session(), cmd: f.startupCmd() };
    expect(repairPaneResume(db, f.paneId)).toBeNull();
    expect({ ...f.session(), cmd: f.startupCmd() }).toEqual(before);
  });

  it('leaves a pane with no session row alone', () => {
    const panes = new PaneStore(db);
    const workspaces = new WorkspaceStore(db);
    const tabs = new TabStore(db);
    const ws = workspaces.create({ name: 'W2' });
    const tab = tabs.create({ name: 'T2', layout: 'p1', workspace_id: ws.id });
    const pane = panes.create({ tab_id: tab.id, shell: '/bin/zsh', startup_cmd: 'muxpad agent' });
    expect(planResumeRepair(db, pane.id)).toBeNull();
  });

  it('is deterministic with several candidates — newest wins, sid breaks a tie', () => {
    const f = fixture();
    const older = 'aaaaaaaa-0000-0000-0000-000000000001';
    const tieA = 'bbbbbbbb-0000-0000-0000-000000000002';
    const tieB = 'aaaaaaaa-0000-0000-0000-000000000003';
    f.history(older, 'codex', 1000);
    // Two rows written in the same millisecond — a real boot does this.
    f.history(tieA, 'codex', 2000);
    f.history(tieB, 'codex', 2000);
    f.history(DRIFTED, 'codex', 3000);
    f.pointAt(DRIFTED, [older, tieA, tieB, DRIFTED]);
    writeMuxpadTranscript(older);
    writeMuxpadTranscript(tieA);
    writeMuxpadTranscript(tieB);
    const first = planResumeRepair(db, f.paneId);
    expect(first?.candidates).toBe(3);
    // `last_seen DESC, sid ASC` — the tie resolves to the lexicographically
    // smaller sid, and does so identically on every call.
    expect(first?.to).toBe(tieB);
    for (let i = 0; i < 5; i++) expect(planResumeRepair(db, f.paneId)?.to).toBe(tieB);
  });

  it('searches BOTH transcript stores', () => {
    // A pane converted between harnesses: the newest recoverable conversation
    // is a Claude one, living under ~/.claude/projects — not in the muxpad log
    // dir the pane's current backend writes to.
    const f = fixture();
    const codexOld = 'cccccccc-0000-0000-0000-000000000001';
    const claudeNew = 'dddddddd-0000-0000-0000-000000000002';
    f.history(codexOld, 'codex', 1000);
    f.history(claudeNew, 'claude', 2000);
    f.history(DRIFTED, 'codex', 3000);
    f.pointAt(DRIFTED, [codexOld, claudeNew, DRIFTED]);
    writeMuxpadTranscript(codexOld);
    writeClaudeTranscript(claudeNew);
    expect(locateAnyTranscript(codexOld)).toContain('agent-transcripts');
    expect(locateAnyTranscript(claudeNew)).toContain('projects');
    const plan = planResumeRepair(db, f.paneId);
    expect(plan?.to).toBe(claudeNew);
    expect(plan?.candidates).toBe(2);
  });

  it('refuses a historical sid that could not be typed into a shell', () => {
    const f = fixture();
    const nasty = 'evil;id';
    f.history(nasty, 'codex', 5000);
    f.history(DRIFTED, 'codex', 3000);
    f.pointAt(DRIFTED, [nasty, DRIFTED]);
    // Give the hostile id a transcript, so ONLY the charset gate can reject it.
    mkdirSync(join(tmp, 'data', 'agent-transcripts'), { recursive: true });
    writeFileSync(join(tmp, 'data', 'agent-transcripts', `${nasty}.jsonl`), '{}\n');
    expect(planResumeRepair(db, f.paneId)).toBeNull();
  });
});

describe('the write-back', () => {
  it('moves current_sid, the harness label and the startup command', () => {
    const f = realIncident();
    const repair = repairPaneResume(db, f.paneId);
    expect(repair?.to).toBe(CODEX_REAL);
    const session = f.session();
    expect(session.current_sid).toBe(CODEX_REAL);
    // The accidental fresh session that caused the drift was a CLAUDE one, and
    // it relabelled the pane on its way past. The recovered sid's own registry
    // row says codex — restore that too, or the respawn resumes a codex
    // conversation under the wrong harness.
    expect(session.assistant).toBe('codex');
    expect(f.startupCmd()).toBe(
      `muxpad agent --backend codex --model gpt-6-astra --resume ${CODEX_REAL}`,
    );
  });

  it('keeps the drifted sid in the lineage — nothing is erased', () => {
    const f = realIncident();
    repairPaneResume(db, f.paneId);
    expect(JSON.parse(f.session().lineage)).toContain(DRIFTED);
    // …and the registry still knows every sid the pane ever carried.
    const sids = (
      db.prepare('SELECT sid FROM session_history WHERE pane_id = ?').all(f.paneId) as Array<{
        sid: string;
      }>
    ).map((r) => r.sid);
    expect(sids).toEqual(expect.arrayContaining([CLAUDE_FIRST, CODEX_EARLY, CODEX_REAL, DRIFTED]));
  });

  it('is idempotent — a second pass finds nothing left to do', () => {
    const f = realIncident();
    expect(repairPaneResume(db, f.paneId)).not.toBeNull();
    expect(repairPaneResume(db, f.paneId)).toBeNull();
  });

  it('repairs every drifted pane in one boot pass, and no others', () => {
    const broken = realIncident();
    const fine = fixture('muxpad agent --backend codex');
    const ok = 'eeeeeeee-0000-0000-0000-000000000001';
    fine.history(ok, 'codex', 9000);
    fine.pointAt(ok, [ok]);
    writeMuxpadTranscript(ok);
    const repairs = repairAllResumeTargets(db);
    expect(repairs.map((r) => r.pane_id)).toEqual([broken.paneId]);
  });
});

describe('rewriteResumeCmd', () => {
  it('re-points an existing --resume and preserves every other flag', () => {
    expect(
      rewriteResumeCmd("muxpad agent --backend codex --mode chat --model 'gpt-6' --resume old", 'new', 'codex'),
    ).toBe("muxpad agent --backend codex --mode chat --model 'gpt-6' --resume new");
  });

  it('adds --resume to a command that lost it to the dead-session heal', () => {
    expect(rewriteResumeCmd('muxpad agent --backend codex', 'new', 'codex')).toBe(
      'muxpad agent --backend codex --resume new',
    );
  });

  it('restores a --backend the drift dropped', () => {
    expect(rewriteResumeCmd("muxpad agent --model 'gpt-6-astra' --resume old", 'new', 'codex')).toBe(
      "muxpad agent --backend codex --model 'gpt-6-astra' --resume new",
    );
  });

  it('drops --backend when the recovered session is a claude one', () => {
    // Claude is IMPLICIT in a startup command; leaving `--backend codex` would
    // resume a Claude transcript through the wrong harness.
    expect(rewriteResumeCmd('muxpad agent --backend codex --resume old', 'new', 'claude')).toBe(
      'muxpad agent --resume new',
    );
  });

  it('leaves the backend untouched when the registry never recorded one', () => {
    expect(rewriteResumeCmd('muxpad agent --backend cursor --resume old', 'new', null)).toBe(
      'muxpad agent --backend cursor --resume new',
    );
  });
});

describe('announcing it', () => {
  it('names both sids, and says how many candidates there were', () => {
    const f = realIncident();
    const plan = planResumeRepair(db, f.paneId);
    if (!plan) throw new Error('expected a plan');
    const line = describeRepair(plan);
    expect(line).toContain('8a2c3628');
    expect(line).toContain('01a0b091');
    expect(line).toContain('recovered a stranded conversation');
    // One candidate — no need to mention the choice.
    expect(line).not.toContain('took the newest');
  });

  it('says it chose, when there was a choice', () => {
    const f = fixture();
    const a = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const b = 'bbbbbbbb-0000-0000-0000-00000000000b';
    f.history(a, 'codex', 1000);
    f.history(b, 'codex', 2000);
    f.history(DRIFTED, 'codex', 3000);
    f.pointAt(DRIFTED, [a, b, DRIFTED]);
    writeMuxpadTranscript(a);
    writeMuxpadTranscript(b);
    const plan = planResumeRepair(db, f.paneId);
    if (!plan) throw new Error('expected a plan');
    expect(describeRepair(plan)).toContain('2 had one; took the newest');
  });

  it('the server repairs at boot and reaches the user', async () => {
    const f = realIncident();
    const quiet = fixture('muxpad agent --backend codex');
    const only = '79bf6193-867f-44aa-bd76-79128525f799';
    quiet.history(only, 'codex', 10);
    quiet.pointAt(only, [only]);

    const pushes: Array<[string, string]> = [];
    const http = createServer();
    const handle = attachWsServer({
      http,
      db,
      // Construction does no ptyd I/O; the sweep that would is never run here.
      ptyd: { getForegroundCommand: async () => null } as unknown as PtydClient,
      cache: new PtydCache(),
      events: new EventBus(),
      notifyPane: (paneId: string, body: string): PaneNotifyOutcome => {
        pushes.push([paneId, body]);
        return 'sent';
      },
    });
    try {
      // The drifted pane is repaired…
      expect(f.session().current_sid).toBe(CODEX_REAL);
      // …the never-used one is untouched, and nothing was said about it.
      expect(quiet.session().current_sid).toBe(only);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]?.[0]).toBe(f.paneId);
      expect(pushes[0]?.[1]).toContain('01a0b091');
    } finally {
      await handle.close();
    }
  });
});
