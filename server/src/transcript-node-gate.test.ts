import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_NODE_ID, NodeStore } from './store/NodeStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

/**
 * ── SESSION IDS ARE NOT A CAPABILITY ─────────────────────────────────────
 *
 * The transcript locators search by SESSION ID on the server's own disk, with
 * no notion of which machine a pane belongs to. A trust-boundary review found
 * the attack: a compromised host reports its own pane's session id as some
 * PERSONAL chat's sid — the runner `hello` validates the sid's SHAPE and
 * nothing else — and the server then serves that conversation as the remote
 * pane's history, both back to the host through its own correctly-scoped
 * route and out to every browser watching the chat.
 *
 * Session ids are not secret. They sit in plain sight inside `startup_cmd` as
 * `--resume <sid>`, in session listings, and in events.
 *
 * The defence cannot be "validate the sid" — it has to be "never look up a
 * remote pane's history on this disk at all". These tests pin the predicate
 * both gates use.
 */
let dir: string;
let db: Database.Database;
let ws: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-tgate-'));
  db = openDb(join(dir, 'db.sqlite'));
  ws = new WorkspaceStore(db).create({ name: 'W' }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const paneOn = (node?: string) => {
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  const id = new PaneStore(db).create({
    tab_id: tab,
    shell: '/bin/zsh',
    cwd: '/tmp',
    ...(node ? { node_id: node } : {}),
  }).id;
  return id;
};

describe('whose disk may be searched', () => {
  it('a local pane resolves local, so its history is readable here', () => {
    const nodes = new NodeStore(db);
    expect(nodes.nodeForPane(paneOn())).toBe(LOCAL_NODE_ID);
  });

  it('a REMOTE pane never resolves local, however its sid looks', () => {
    // The sid is irrelevant to the decision, which is the point: no sid, however
    // well-formed or well-guessed, can make a remote pane readable from here.
    const nodes = new NodeStore(db);
    const p = paneOn('trayo');
    expect(nodes.nodeForPane(p)).toBe('trayo');
    expect(nodes.nodeForPane(p)).not.toBe(LOCAL_NODE_ID);
  });

  it('an unknown pane reads local — the pre-migration meaning, and safe here', () => {
    // Safe because an unknown pane has no session either, so both gates fall
    // through to their existing not-found paths.
    expect(new NodeStore(db).nodeForPane('01NOSUCHPANE00000000000000')).toBe(LOCAL_NODE_ID);
  });

  it('both gates ask the same question, so they cannot drift apart', () => {
    // One in ws.ts (the live chat tail), one in routes/agent-sessions.ts (the
    // HTTP transcript route). A review found the second after the first was
    // written; a third caller must not be able to miss it.
    const src = [readSrc('ws.ts'), readSrc('routes/agent-sessions.ts')];
    for (const s of src) {
      expect(s).toMatch(/nodeForPane|paneIsLocal/);
    }
  });
});

function readSrc(rel: string): string {
  // eslint-disable-next-line
  return require('node:fs').readFileSync(join(import.meta.dirname, rel), 'utf8');
}
