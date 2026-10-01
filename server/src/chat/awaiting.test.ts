import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { endsAwaitingUser, paneAwaitsUser } from './awaiting.js';

/**
 * "IT IS ESSENTIALLY AWAITING INSTRUCTIONS — BUT IT'S MARKED AS DONE."
 *
 * `cross-ws` investigated cross-workspace navigation, published a page, wrote a
 * 13 KB report, and ended its turn asking which option to take. The database
 * says `retired_reason = delivered`. Retirement fires at TURN-END, so "I
 * finished the job" and "I finished a turn and the ball is in your court" were
 * one state — and they are opposites: the first wants archiving and the second
 * wants your attention, and archiving the second is the worst available answer.
 *
 * ─── Why this reads the LAST MESSAGE and not the pane's `blocked` flag ───────
 * `blocked` is the obvious candidate and it is ALREADY WIRED: ChatRetirer's
 * keep-list has consulted it from the first commit (`stillWorking`). It did not
 * fire for `cross-ws`, because it means "the harness reported a pending
 * question" — a tool-level prompt — and an agent that simply ends its prose with
 * "which would you prefer?" never raises one. So the signal exists, is correct,
 * and does not cover this case; the text is the only place the question is.
 *
 * ─── …and not the summariser's judgement ─────────────────────────────────────
 * The other candidate was to have the one-shot classify it. It is the better
 * READER, and it is disqualified by this very bug: the model call is exactly
 * what failed for `cross-ws` (its report was generated and then refused by a
 * length rule), and a classification that disappears whenever the generator
 * disappears would default to `delivered` — which is the bug.
 *
 * So: a deterministic read of the last message, no model in the path, available
 * even when everything else has failed.
 */
describe('endsAwaitingUser — did it stop to ask you something', () => {
  it('catches a question', () => {
    expect(endsAwaitingUser('Published the options page. Which arrangement do you want?')).toBe(
      true,
    );
  });

  it('catches a request to choose that is not punctuated as a question', () => {
    // The real shape of `cross-ws`'s ending: a recommendation and an invitation,
    // with a full stop on the end.
    expect(endsAwaitingUser('Four options are on the page. Let me know which to build.')).toBe(
      true,
    );
    expect(endsAwaitingUser('I recommend the switcher. Your call.')).toBe(true);
    expect(endsAwaitingUser('Ready to implement whichever you pick.')).toBe(true);
    expect(endsAwaitingUser('Should I go ahead with option B')).toBe(true);
  });

  it('CATCHES THE INVESTIGATION THAT RECOMMENDED AND DID NOT ACT', () => {
    // `cross-ws`, verbatim from its transcript — the case that produced the
    // complaint, and the one neither a question mark nor an invitation sees. It
    // never asks; it recommends and says out loud that it changed nothing, which
    // is the same handover made implicitly.
    expect(
      endsAwaitingUser(
        'Published and reported. Recommended options 1 + 5 — both zero-chrome, orthogonal, and unable to collide with `sidebar-slack`. Nothing implemented; no files under `web/` touched; preview server torn down.',
      ),
    ).toBe(true);
  });

  it('leaves a finished report alone', () => {
    // The common case by far, and the one that must keep retiring: a worker that
    // did the job and said so. If this went the other way the `done` group would
    // fill up again, which is the problem the whole lifecycle answers.
    expect(
      endsAwaitingUser('Counted 41 TODO comments across 6 files. The list is at /tmp/todos.md.'),
    ).toBe(false);
    expect(endsAwaitingUser('Done. Two dead rules removed and the tests pass.')).toBe(false);
  });

  it('is not fooled by a question ABOUT the work', () => {
    // "the question of whether…" is prose, not an ask.
    expect(
      endsAwaitingUser('Settled the question of which selector wins; the wash now outranks hover.'),
    ).toBe(false);
    // …and a report that ENDS on a quoted question is still a report. This is
    // what the interrogative guard is for: a trailing `?` on its own would take
    // it, and then every worker that signs off by restating what it answered
    // would pin itself into the live list.
    expect(endsAwaitingUser('It settled the open question there: is the wash enough?')).toBe(false);
  });

  it('says NO for an empty message rather than guessing', () => {
    // Nothing to read is not evidence of a question. The alternative — treating
    // silence as "awaiting" — would pin every unreadable child live forever,
    // which is the 41-agent sidebar again.
    expect(endsAwaitingUser('')).toBe(false);
    expect(endsAwaitingUser('   ')).toBe(false);
  });
});

describe('paneAwaitsUser — the same question, against a real transcript', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  let db: Database.Database;
  let workspaceId: string;

  function worker(lines: Array<{ kind: string; text: string }>): string {
    const tabId = new TabStore(db).create({
      name: 'cross-ws',
      workspace_id: workspaceId,
      layout: 'p',
    }).id;
    const paneId = new PaneStore(db).create({ tab_id: tabId }).id;
    const sid = `sid-${paneId}`;
    new AgentSessionStore(db).register({ pane_id: paneId, assistant: 'codex', session_id: sid });
    writeFileSync(
      join(dir, 'agent-transcripts', `${sid}.jsonl`),
      `${lines.map((e, i) => JSON.stringify({ id: String(i), ts: i, ...e })).join('\n')}\n`,
    );
    return paneId;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-awaiting-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dir;
    mkdirSync(join(dir, 'agent-transcripts'), { recursive: true });
    db = openDb(join(dir, 'db.sqlite'));
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  afterEach(() => {
    db.close();
    // biome-ignore lint/performance/noDelete: restoring an env var that wasn't set
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the LAST message, not an earlier one', async () => {
    // A worker asks plenty of rhetorical questions on the way through. Only the
    // one it stopped on decides anything.
    const paneId = worker([
      { kind: 'user', text: 'investigate cross-workspace navigation' },
      { kind: 'assistant', text: 'Which of these is the real constraint?' },
      { kind: 'assistant', text: 'Done. Four options are on the published page.' },
    ]);
    expect(paneAwaitsUser(db, paneId)).toBe(false);
  });

  it('catches the worker that stopped to ask', () => {
    const paneId = worker([
      { kind: 'user', text: 'investigate cross-workspace navigation' },
      { kind: 'assistant', text: 'Four options are on the page. Which should I build?' },
    ]);
    expect(paneAwaitsUser(db, paneId)).toBe(true);
  });

  it('says NO for a pane with no transcript at all', () => {
    // Unreadable is not "awaiting". Stated as its own case because the default
    // here is the whole decision: `delivered` is what produced the bug, but
    // "I cannot read it" is not evidence of a question either, and pinning every
    // unreadable child live forever is the failure mode on the other side.
    const tabId = new TabStore(db).create({ name: 'x', workspace_id: workspaceId, layout: 'p' }).id;
    const paneId = new PaneStore(db).create({ tab_id: tabId }).id;
    expect(paneAwaitsUser(db, paneId)).toBe(false);
  });
});
