import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { transcriptForPane, transcriptIsLocal } from './transcript-access.js';

/**
 * ── ONE CHOKEPOINT, AND THREE ANSWERS THAT MUST STAY APART ───────────────
 *
 * The locators search BY SESSION ID on this server's disk with no notion of
 * which machine a pane is on, so a host naming a personal chat's sid could
 * have that conversation served as its own pane's history. Session ids are
 * not secret — they sit in `startup_cmd` as `--resume <sid>`.
 *
 * It was first "fixed" at two call sites with a commit claiming the server
 * NEVER reads its own disk for another machine's chat. A review counted
 * seven readers; two were gated. Hence one chokepoint.
 *
 * And the result is deliberately not `string | null`: `null` reads naturally
 * as "no transcript", which for `agentPaneHasMessages` is the DESTRUCTIVE
 * answer — its own comment says a false negative there is a destroyed
 * conversation.
 */
let dir: string;
let db: Database.Database;
let ws: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-tacc-'));
  db = openDb(join(dir, 'db.sqlite'));
  ws = new WorkspaceStore(db).create({ name: 'W' }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const paneOn = (node?: string) => {
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  return new PaneStore(db).create({
    tab_id: tab,
    shell: '/bin/zsh',
    cwd: '/tmp',
    ...(node ? { node_id: node } : {}),
  }).id;
};

describe('the three answers', () => {
  it('a local pane with no file is ABSENT, not elsewhere', () => {
    const a = transcriptForPane(db, paneOn(), 'no-such-sid-0001', 'claude');
    expect(a.kind).toBe('absent');
  });

  it('a local pane with no sid is ABSENT', () => {
    expect(transcriptForPane(db, paneOn(), null).kind).toBe('absent');
  });

  it('a REMOTE pane is ELSEWHERE, and names the machine', () => {
    const a = transcriptForPane(db, paneOn('trayo'), 'anything', 'claude');
    expect(a).toEqual({ kind: 'elsewhere', nodeId: 'trayo' });
  });

  it('no sid can make a remote pane readable — the sid is not even consulted', () => {
    // The whole point: the decision is about the MACHINE, so a well-guessed
    // session id buys nothing.
    for (const sid of ['0cdf8641-453a-4b22-84a2-69a2bb2ae4cf', '../../etc/passwd', '']) {
      expect(transcriptForPane(db, paneOn('trayo'), sid, 'claude').kind).toBe('elsewhere');
    }
  });

  it('a pane with NO ROW is elsewhere, NOT local', () => {
    // nodeForPane maps a missing pane to `local` — right for its own purpose
    // (the pre-migration meaning) and wrong here, where it would turn "I have
    // never heard of this pane" into "search my disk by this id".
    const a = transcriptForPane(db, '01NOSUCHPANE00000000000000', 'some-sid', 'claude');
    expect(a.kind).toBe('elsewhere');
  });
});

describe('the boolean helper agrees with it', () => {
  it('local pane true, remote false, unknown false', () => {
    expect(transcriptIsLocal(db, paneOn())).toBe(true);
    expect(transcriptIsLocal(db, paneOn('trayo'))).toBe(false);
    expect(transcriptIsLocal(db, '01NOSUCHPANE00000000000000')).toBe(false);
  });
});
