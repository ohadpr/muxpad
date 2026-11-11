import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { wrapRebase } from './rebase.js';
import {
  checkTranscript,
  planTranscriptRebase,
  renderTranscriptRebase,
  transcriptRebase,
} from './transcript-rebase.js';

/**
 * A REPLAY THE API REJECTS IS WORSE THAN NO FEATURE — the chat would not start.
 *
 * So these fixtures are shaped like the real files they stand in for (one
 * entry per content block, parallel tool calls forking the chain, compactions
 * that re-append what they preserved), and every rendered output is run back
 * through checkTranscript, the same gate the server applies before writing.
 */

type E = Record<string, unknown>;
let n = 0;
let clock = Date.parse('2026-11-01T00:00:00Z');
const at = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};
const base = (uuid: string, parent: string | null): E => ({
  uuid,
  parentUuid: parent,
  isSidechain: false,
  sessionId: 'old-sid',
  cwd: '/work',
  timestamp: at(),
});
const user = (uuid: string, parent: string | null, content: unknown): E => ({
  ...base(uuid, parent),
  type: 'user',
  message: { role: 'user', content },
});
const text = (uuid: string, parent: string | null, t: string, msg = `m${++n}`): E => ({
  ...base(uuid, parent),
  type: 'assistant',
  message: { id: msg, role: 'assistant', content: [{ type: 'text', text: t }] },
});
const use = (uuid: string, parent: string | null, id: string, msg = `m${++n}`): E => ({
  ...base(uuid, parent),
  type: 'assistant',
  message: {
    id: msg,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
  },
});
const result = (uuid: string, parent: string | null, id: string, out = 'ok'): E =>
  user(uuid, parent, [{ type: 'tool_result', tool_use_id: id, content: out }]);
const attach = (uuid: string, parent: string | null, attachment: E): E => ({
  ...base(uuid, parent),
  type: 'attachment',
  attachment,
});
const jsonl = (entries: E[]) => entries.map((e) => JSON.stringify(e)).join('\n');

function rebase(entries: E[], opts: { budgetTokens?: number; chunkBytes?: number } = {}) {
  const r = planTranscriptRebase(jsonl(entries), opts);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  const out = renderTranscriptRebase(r.plan, 'new-sid', r.plan.dropped ? 'the older part' : null);
  const lines = out
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as E);
  return { plan: r.plan, out, lines };
}
const userTexts = (lines: E[]) =>
  lines
    .filter((e) => e.type === 'user')
    .map((e) => (e.message as { content: unknown }).content)
    .flatMap((c) =>
      typeof c === 'string'
        ? [c]
        : (c as E[]).filter((b) => b.type === 'text').map((b) => String(b.text)),
    );

describe('the stale material it removes', () => {
  it('strips muxpad-authored blocks and keeps what was actually asked', () => {
    const { lines, out } = rebase([
      user(
        'u1',
        null,
        '<muxpad-instructions>\nold rules\n</muxpad-instructions>\n\n<muxpad-mode>\nchat mode\n</muxpad-mode>\n\nbuild the broker',
      ),
      text('a1', 'u1', 'on it'),
      user(
        'u2',
        'a1',
        '<muxpad-cron id="c1" name="pr-sweep">\nDelivered by the muxpad cron "pr-sweep" — a scheduled job, not a human.\n</muxpad-cron>\n\ncheck the PRs',
      ),
      text('a2', 'u2', 'checked'),
      user(
        'u3',
        'a2',
        'what did @Investing say\n\n<muxpad-context count="1">\nThe message above mentions another muxpad chat.\n- @Investing — tab t1, pane(s) p1\n</muxpad-context>',
      ),
      text('a3', 'u3', 'cash'),
    ]);
    expect(userTexts(lines)).toEqual([
      'build the broker',
      'check the PRs',
      'what did @Investing say',
    ]);
    expect(out).not.toMatch(/old rules|chat mode|scheduled job|<muxpad-context/);
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });

  it('leaves a muxpad tag the user merely QUOTED', () => {
    // This repo's own chats discuss these tags all day. Only a block muxpad
    // PREPENDED is plumbing; one in the middle of a sentence is the sentence.
    const said = 'why does <muxpad-cron id="x">hi</muxpad-cron> render as a chip?';
    const { lines } = rebase([user('u1', null, said), text('a1', 'u1', 'because')]);
    expect(userTexts(lines)).toEqual([said]);
  });

  it('strips system reminders, and drops a message that was nothing else', () => {
    const { lines, out } = rebase([
      user('u1', null, '<system-reminder>\nToday is 2026-09-01.\n</system-reminder>\nhello'),
      text('a1', 'u1', 'hi', 'mA'),
      use('a2', 'a1', 't1', 'mA'),
      result(
        'r1',
        'a2',
        't1',
        'file body\n<system-reminder>\nconsider malware\n</system-reminder>',
      ),
      user('u2', 'r1', '<system-reminder>\nThe user has not heard from you.\n</system-reminder>'),
      text('a3', 'u2', 'done'),
    ]);
    expect(userTexts(lines)).toEqual(['hello']);
    expect(out).not.toMatch(/2026-09-01|malware|not heard/);
    // The tool result itself survives — only its trailing reminder went.
    expect(out).toContain('file body');
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });

  it('drops harness plumbing: slash-command wrappers and caveats', () => {
    const { lines } = rebase([
      user('u1', null, 'real question'),
      text('a1', 'u1', 'answer'),
      user('u2', 'a1', '<command-name>/compact</command-name>'),
      user('u3', 'u2', '<local-command-stdout>Compacted</local-command-stdout>'),
      user('u4', 'u3', 'next question'),
      text('a2', 'u4', 'next answer'),
    ]);
    expect(userTexts(lines)).toEqual(['real question', 'next question']);
  });

  it('drops the reminder-only attachments and keeps a message typed mid-turn', () => {
    const { lines, plan } = rebase([
      user('u1', null, 'go'),
      attach('x1', 'u1', { type: 'environment', snapshot: {} }),
      attach('x2', 'x1', { type: 'instructions', files: [{ content: 'OLD CLAUDE.md' }] }),
      attach('x3', 'x2', { type: 'queued_command', prompt: 'also do Y', commandMode: 'prompt' }),
      text('a1', 'x3', 'doing X and Y'),
    ]);
    expect(lines.map((e) => e.type)).toEqual(['user', 'attachment', 'assistant']);
    expect((lines[1]?.attachment as E).prompt).toBe('also do Y');
    expect(plan.stats.attachments).toEqual({ environment: 1, instructions: 1 });
  });
});

describe('compactions are UNDONE, not just dropped', () => {
  it('follows the boundary back to the turns it hid, and drops the summary', () => {
    // How a compaction hides history: a boundary with NO parent that names the
    // old leaf in `logicalParentUuid`. Stopping at the boundary — which is all
    // `--resume` does — would keep the summary and lose the turns.
    const { lines, out } = rebase([
      user('u1', null, 'the original ask: port it to linux'),
      text('a1', 'u1', 'ported'),
      {
        ...base('b1', null),
        type: 'system',
        subtype: 'compact_boundary',
        logicalParentUuid: 'a1',
        compactMetadata: { trigger: 'auto', preTokens: 150000 },
      },
      {
        ...user(
          's1',
          'b1',
          'This session is being continued from a previous conversation that ran out of context. Summary: old rules',
        ),
        isCompactSummary: true,
      },
      user('u2', 's1', 'now ship it'),
      text('a2', 'u2', 'shipped'),
    ]);
    expect(userTexts(lines)).toEqual(['the original ask: port it to linux', 'now ship it']);
    expect(out).not.toContain('being continued');
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });

  it('survives the re-appended preserved turns without a cycle or a duplicate', () => {
    // Measured shape: after a partial compaction the harness RE-APPENDS the
    // turns it kept, re-parented onto the summary, so the newest copy of the
    // boundary's logical parent sits AFTER the boundary. Taking the newest copy
    // blindly walks in a circle and loses everything before it.
    const { lines, out } = rebase([
      user('u1', null, 'first'),
      text('a1', 'u1', 'one'),
      user('u2', 'a1', 'second'),
      text('a2', 'u2', 'two'),
      {
        ...base('b1', null),
        type: 'system',
        subtype: 'compact_boundary',
        logicalParentUuid: 'a2',
      },
      {
        ...user(
          's1',
          'b1',
          'This session is being continued from a previous conversation that ran out of context.',
        ),
        isCompactSummary: true,
      },
      // The preserved turns, again, same uuids, new parents.
      user('u2', 's1', 'second'),
      text('a2', 'u2', 'two'),
      user('u3', 'a2', 'third'),
      text('a3', 'u3', 'three'),
    ]);
    expect(userTexts(lines)).toEqual(['first', 'second', 'third']);
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });
});

describe('a tool call and its result go together or not at all', () => {
  it('drops a tool call whose result was never written (a chat rebased mid-turn)', () => {
    const { out, plan } = rebase([
      user('u1', null, 'list files'),
      use('a1', 'u1', 't1'),
      result('r1', 'a1', 't1'),
      text('a2', 'r1', 'here they are'),
      user('u2', 'a2', 'and again'),
      use('a3', 'u2', 't2'),
    ]);
    expect(plan.stats.orphanToolUses).toBe(1);
    expect(out).toContain('"t1"');
    expect(out).not.toContain('"t2"');
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });

  it('drops a result whose call is gone', () => {
    const { out, plan } = rebase([
      user('u1', null, 'go'),
      text('a1', 'u1', 'thinking'),
      user('r1', 'a1', [
        { type: 'tool_result', tool_use_id: 'ghost', content: 'x' },
        { type: 'text', text: 'and a real remark' },
      ]),
      text('a2', 'r1', 'ok'),
    ]);
    expect(plan.stats.orphanToolResults).toBe(1);
    expect(out).not.toContain('ghost');
    expect(out).toContain('and a real remark');
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });

  it('recovers the result of a PARALLEL call from its sibling branch', () => {
    // Two tool_uses in one message are two entries, the second a child of the
    // first, and the first call's result hangs off the first entry — a branch
    // the leaf walk never visits. Missing it is an orphan tool_use per
    // parallel call: two of them in a real 8 MB transcript.
    const { out, lines } = rebase([
      user('u1', null, 'read both'),
      use('a1', 'u1', 'tA', 'mP'),
      use('a2', 'a1', 'tB', 'mP'),
      result('rA', 'a1', 'tA', 'A'),
      result('rB', 'a2', 'tB', 'B'),
      text('a3', 'rB', 'both read'),
    ]);
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
    // Calls first, then both results — the shape the API wants.
    expect(lines.map((e) => e.uuid && (e.message as { content: E[] }).content[0]?.type)).toEqual([
      undefined,
      'tool_use',
      'tool_use',
      'tool_result',
      'tool_result',
      'text',
    ]);
  });
});

describe('the chain it writes', () => {
  it('is ONE linear chain with fresh ids, however much was dropped', () => {
    const { lines } = rebase([
      user('u1', null, 'go'),
      attach('x1', 'u1', { type: 'date', date: 'today' }),
      text('a1', 'x1', 'went'),
      user('u2', 'a1', '<system-reminder>only this</system-reminder>'),
      user('u3', 'u2', 'again'),
      text('a2', 'u3', 'again done'),
    ]);
    let prev: unknown = null;
    for (const e of lines) {
      expect(e.parentUuid).toBe(prev);
      expect(e.sessionId).toBe('new-sid');
      expect(['u1', 'x1', 'a1', 'u2', 'u3', 'a2']).not.toContain(e.uuid);
      prev = e.uuid;
    }
    expect(lines).toHaveLength(4);
  });

  it('stops cleanly at a parent the file does not have, and says so', () => {
    const { plan, out } = rebase([
      user('u2', 'missing-parent', 'carry on'),
      text('a2', 'u2', 'carrying on'),
    ]);
    expect(plan.stats.danglingSource).toBe(1);
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });

  it('reads lines that straddle the read boundary', () => {
    // The 604 MB transcript does not fit in a JS string, so it is read in
    // chunks; a line split across two chunks must still parse.
    const entries = [user('u1', null, 'x'.repeat(500)), text('a1', 'u1', 'y'.repeat(500))];
    const r = planTranscriptRebase(jsonl(entries), { chunkBytes: 37 });
    expect(r.ok && r.plan.kept.length).toBe(2);
  });
});

describe('a history too big to replay', () => {
  const long = () => {
    const out: E[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 20; i++) {
      out.push(user(`u${i}`, parent, `turn ${i} ${'w'.repeat(3000)}`));
      out.push(use(`a${i}`, `u${i}`, `t${i}`));
      out.push(result(`r${i}`, `a${i}`, `t${i}`, 'o'.repeat(3000)));
      out.push(text(`z${i}`, `r${i}`, `done ${i}`));
      parent = `z${i}`;
    }
    return out;
  };

  it('keeps the most recent WHOLE turns and briefs the rest in one leading entry', () => {
    const { plan, lines, out } = rebase(long(), { budgetTokens: 12_000 });
    expect(plan.dropped?.count).toBeGreaterThan(0);
    // The briefing reads the dropped span, and only it.
    expect(plan.dropped?.ends.join('\n')).toContain('turn 0 ');
    expect(plan.dropped?.ends.join('\n')).not.toContain('turn 19 ');
    expect(String((lines[0]?.message as E).content)).toMatch(/^<muxpad-history>/);
    // Right after it, a turn START — never the middle of a tool exchange.
    expect(userTexts([lines[1] as E])[0]).toMatch(/^turn \d+ /);
    expect(out).toContain('turn 19 ');
    expect(plan.tokens.kept).toBeLessThanOrEqual(12_000);
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
  });

  it('will not drop the older span without a briefing to stand for it', () => {
    const r = planTranscriptRebase(jsonl(long()), { budgetTokens: 12_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(() => renderTranscriptRebase(r.plan, 's', null)).toThrow(/briefing/);
  });

  it('refuses when even the latest turn does not fit', () => {
    const r = planTranscriptRebase(jsonl(long()), { budgetTokens: 500 });
    expect(r).toMatchObject({ ok: false, reason: 'last_turn_too_large' });
  });

  it('keeps the history an EARLIER rebase left, so a second rebase loses nothing', () => {
    // <muxpad-history> is the one muxpad block that is conversation, not
    // instruction; and a briefing-only rebase's block is turned into one,
    // keeping the briefing and dropping its prose about tools.
    const { lines, out } = rebase([
      user('u0', null, wrapRebase('GOAL: ship the broker')),
      text('a0', 'u0', 'understood'),
      user('u1', 'a0', 'continue'),
      text('a1', 'u1', 'continuing'),
    ]);
    expect(userTexts(lines)[0]).toMatch(/^<muxpad-history>[\s\S]*GOAL: ship the broker/);
    expect(out).not.toContain('older build of muxpad');
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
    const again = rebase(lines.map((e) => ({ ...e, sessionId: 'old-sid' })));
    expect(userTexts(again.lines)[0]).toContain('GOAL: ship the broker');
  });
});

describe('the integrity gate', () => {
  const good = () =>
    rebase([user('u1', null, 'go'), use('a1', 'u1', 't1'), result('r1', 'a1', 't1')]).lines;
  const str = (ls: E[]) => ls.map((e) => JSON.stringify(e)).join('\n');

  it('passes a sound transcript', () => {
    expect(checkTranscript(str(good()), 'new-sid')).toEqual([]);
  });

  it('catches an orphaned call, a dangling parent and a stray session id', () => {
    const ls = good();
    expect(checkTranscript(str(ls.slice(0, 2)), 'new-sid').join()).toMatch(/has no tool_result/);
    const dangling = ls.map((e, i) => (i === 2 ? { ...e, parentUuid: 'nowhere' } : e));
    expect(checkTranscript(str(dangling), 'new-sid').join()).toMatch(/parent/);
    expect(checkTranscript(str(ls), 'other-sid').join()).toMatch(/sessionId/);
  });
});

// ── the side-effecting wrapper ─────────────────────────────────────────────

describe('transcriptRebase', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-trb-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    db = openDb(join(dir, 'db.sqlite'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const pane = (opts: { node?: string; assistant?: string; sid?: string } = {}) => {
    const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
    const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
    const id = new PaneStore(db).create({
      tab_id: tab,
      shell: '/bin/zsh',
      cwd: '/work',
      ...(opts.node ? { node_id: opts.node } : {}),
    }).id;
    new AgentSessionStore(db).register({
      pane_id: id,
      assistant: opts.assistant ?? 'claude',
      session_id: opts.sid ?? 'old-sid',
    });
    return id;
  };
  const project = () => {
    const p = join(dir, 'projects', '-work');
    mkdirSync(p, { recursive: true });
    const src = jsonl([
      user('u1', null, '<muxpad-mode>\nx\n</muxpad-mode>\n\nhi'),
      text('a1', 'u1', 'hello'),
    ]);
    writeFileSync(join(p, 'old-sid.jsonl'), src);
    return { p, src };
  };

  it('writes a NEW file next to the old one and leaves the old one alone', async () => {
    const { p, src } = project();
    const r = await transcriptRebase(db, pane(), { mintSid: () => 'new-sid' });
    expect(r).toMatchObject({ ok: true, sid: 'new-sid', briefed: false });
    expect(readFileSync(join(p, 'old-sid.jsonl'), 'utf8')).toBe(src);
    const out = readFileSync(join(p, 'new-sid.jsonl'), 'utf8');
    expect(checkTranscript(out, 'new-sid')).toEqual([]);
    expect(out).not.toContain('muxpad-mode');
    // No temp file left behind.
    expect(readdirSync(p).sort()).toEqual(['new-sid.jsonl', 'old-sid.jsonl']);
  });

  it('refuses a pane on another machine without reading anything', async () => {
    project();
    const r = await transcriptRebase(db, pane({ node: 'trayo' }));
    expect(r).toMatchObject({ ok: false, reason: 'elsewhere' });
  });

  it('refuses a codex chat — its log is not a file its harness resumes from', async () => {
    project();
    const r = await transcriptRebase(db, pane({ assistant: 'codex' }));
    expect(r).toMatchObject({ ok: false, reason: 'not_claude' });
  });

  it('writes nothing when the older span cannot be briefed', async () => {
    const p = join(dir, 'projects', '-work');
    mkdirSync(p, { recursive: true });
    const entries: E[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 10; i++) {
      entries.push(user(`u${i}`, parent, `turn ${i} ${'w'.repeat(3000)}`));
      entries.push(text(`a${i}`, `u${i}`, 'ok'));
      parent = `a${i}`;
    }
    writeFileSync(join(p, 'old-sid.jsonl'), jsonl(entries));
    const r = await transcriptRebase(db, pane(), { budgetTokens: 6000, brief: async () => null });
    expect(r).toMatchObject({ ok: false, reason: 'no_briefing' });
    expect(readdirSync(p)).toEqual(['old-sid.jsonl']);
  });
});
