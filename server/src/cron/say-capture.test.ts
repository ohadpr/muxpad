import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSaid, setSayKey } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { openDb } from '../store/db.js';
import { RESULT_MAX_CHARS, capturedResult } from './say-capture.js';

/**
 * WHAT A FIRE ASKED TO HAVE DELIVERED — read off its own transcript.
 *
 * `muxpad say` posts nothing: it prints a keyed marker to stdout, and the
 * normalizer lifts that into a message. So the only durable record of a spoken
 * block is the transcript, and these are about reading it without delivering
 * things nobody said.
 *
 * The three directions that matter:
 *
 *   ORDINARY PROSE IS NOT A RESULT   forwarding a fire's final paragraph is
 *                                    what turns a "no change" watcher into a
 *                                    daily message.
 *   YESTERDAY IS NOT TODAY           a `--pane` cron fires into a chat with
 *                                    history, including last fire's result.
 *   A QUOTE IS NOT AN INVOCATION     text that merely mentions the marker —
 *                                    `grep -rn muxpad-said .`, this very file
 *                                    — must not speak.
 */
describe('capturedResult', () => {
  let dir: string;
  let db: Database.Database;
  const KEY = 'a1b2c3d4e5f60718';
  const SID = 'fire-session';
  const PANE = 'p1';
  const FIRED = 1_800_000_000_000;

  /** One muxpad-normalised transcript line (the codex/cursor shape). */
  const line = (ev: Record<string, unknown>) => JSON.stringify(ev);

  const write = (...lines: string[]) => {
    mkdirSync(join(dir, 'agent-transcripts'), { recursive: true });
    writeFileSync(join(dir, 'agent-transcripts', `${SID}.jsonl`), `${lines.join('\n')}\n`);
  };

  /** A tool result carrying a spoken block, as `muxpad say` produces it. */
  const spoke = (text: string, ts: number) =>
    line({
      kind: 'tool_result',
      id: `t${ts}`,
      ts,
      toolUseId: `u${ts}`,
      ok: true,
      text: renderSaid(text, KEY),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-say-capture-'));
    process.env.MUXPAD_DATA_DIR = dir;
    setSayKey(KEY);
    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,0,0)',
    ).run('w', 'w', 'W');
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at)
       VALUES ('t','t','T','"p1"','w',0,0)`,
    ).run();
    db.prepare(
      'INSERT INTO panes (id, tab_id, kind, shell, cwd, created_at) VALUES (?,?,?,?,?,0)',
    ).run(PANE, 't', 'agent', '/bin/zsh', '/tmp');
    new AgentSessionStore(db).attachRunner({
      pane_id: PANE,
      session_id: SID,
      assistant: 'codex',
    });
  });

  afterEach(() => {
    setSayKey(null);
    // `Reflect.deleteProperty`, not `= undefined` and not `delete`.
    //
    // `process.env.X = undefined` stores the STRING "undefined" — measured,
    // not assumed — so the next test to read MUXPAD_DATA_DIR would take
    // "undefined" for a directory and write a transcript into ./undefined/.
    // `delete` is the correct operation and is what the lint rule objects to,
    // so this is the same operation by its function form.
    Reflect.deleteProperty(process.env, 'MUXPAD_DATA_DIR');
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures what the fire spoke', () => {
    write(spoke('NET closed at $318 — 10% below the level you named.', FIRED + 10));
    expect(capturedResult(db, PANE, FIRED)).toBe(
      'NET closed at $318 — 10% below the level you named.',
    );
  });

  it('captures NOTHING from a fire that only wrote prose', () => {
    // The most important assertion in this file. Every "no change" watcher
    // ends its turn with a sentence; none of them is a result.
    write(
      line({ kind: 'assistant', id: 'a1', ts: FIRED + 10, text: 'Checked the market. No change.' }),
      line({
        kind: 'tool_result',
        id: 't1',
        ts: FIRED + 11,
        toolUseId: 'u1',
        ok: true,
        text: 'ok',
      }),
    );
    expect(capturedResult(db, PANE, FIRED)).toBeNull();
  });

  it('captures nothing at all from an empty transcript', () => {
    write();
    expect(capturedResult(db, PANE, FIRED)).toBeNull();
  });

  it('joins several spoken blocks in order', () => {
    write(spoke('first', FIRED + 1), spoke('second', FIRED + 2));
    expect(capturedResult(db, PANE, FIRED)).toBe('first\n\nsecond');
  });

  it('ignores blocks from BEFORE this fire', () => {
    // A `--pane` cron fires into a chat with history. Yesterday's result is
    // still in the file, and delivering it would be this feature inventing a
    // result nobody produced today.
    write(spoke('yesterday', FIRED - 86_400_000), spoke('today', FIRED + 5));
    expect(capturedResult(db, PANE, FIRED)).toBe('today');
  });

  it('keeps a block with no timestamp', () => {
    // For a fresh worker that can be every line, and dropping those would
    // deliver nothing from the one target this feature exists for.
    write(
      line({
        kind: 'tool_result',
        id: 't1',
        toolUseId: 'u1',
        ok: true,
        text: renderSaid('spoken', KEY),
      }),
    );
    expect(capturedResult(db, PANE, FIRED)).toBe('spoken');
  });

  it('does not speak text that merely QUOTES the marker', () => {
    // The reason `say` is keyed at all: `cat` a file that mentions it, run the
    // tests, or grep for it while working on this feature.
    write(
      line({
        kind: 'tool_result',
        id: 't1',
        ts: FIRED + 1,
        toolUseId: 'u1',
        ok: true,
        text: '<muxpad-said k="not-the-key">a quote</muxpad-said:not-the-key>',
      }),
    );
    expect(capturedResult(db, PANE, FIRED)).toBeNull();
  });

  it('clips a result too big for somebody else’s context window', () => {
    write(spoke('x'.repeat(RESULT_MAX_CHARS * 2), FIRED + 1));
    const got = capturedResult(db, PANE, FIRED) as string;
    expect(got.length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
    expect(got).toContain('clipped');
  });

  it('answers null for a pane with no session', () => {
    db.prepare(
      'INSERT INTO panes (id, tab_id, kind, shell, cwd, created_at) VALUES (?,?,?,?,?,0)',
    ).run('p-bare', 't', 'agent', '/bin/zsh', '/tmp');
    expect(capturedResult(db, 'p-bare', FIRED)).toBeNull();
  });

  it('answers null for a pane that lives on ANOTHER machine', () => {
    // The chokepoint. This text is about to be injected into another chat, so
    // locating a transcript by session id alone would be the trust hole
    // transcript-access.ts exists to close, with a delivery on the end of it:
    // a compromised host reports a PERSONAL chat's sid as its own pane's, and
    // the result is forwarded into a local agent's context.
    //
    // THE FILE IS WRITTEN FIRST, deliberately: the local transcript exists and
    // contains a spoken block, and the answer is still nothing.
    //
    // What this canNOT prove is that the `kind !== 'local'` line is load
    // bearing — deleting it does not change the answer, because the
    // discriminated union withholds `path` for a remote pane and there is
    // nothing left to read. That is the chokepoint's whole design ("a new
    // reader that forgets to ask simply has no path to call"), so the
    // assertion here is on the OUTCOME, which is the honest thing to assert.
    // A reader that bypassed `transcriptForPane` altogether is the regression
    // this cannot catch, and the architecture is what stops it.
    write(spoke('secret', FIRED + 1));
    db.prepare('UPDATE panes SET node_id = ? WHERE id = ?').run('other-machine', PANE);
    expect(capturedResult(db, PANE, FIRED)).toBeNull();
  });

  it('answers null when the transcript file is missing', () => {
    expect(capturedResult(db, PANE, FIRED)).toBeNull();
  });

  it('skips a corrupt line rather than losing the whole result', () => {
    write('{not json', spoke('survived', FIRED + 1));
    expect(capturedResult(db, PANE, FIRED)).toBe('survived');
  });

  it('ignores a spoken block that is only whitespace', () => {
    write(spoke('   ', FIRED + 1));
    expect(capturedResult(db, PANE, FIRED)).toBeNull();
  });
});
