import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_NODE_ID, NodeStore } from './NodeStore.js';
import { PaneStore } from './PaneStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { openDb } from './db.js';

let dir: string;
let db: Database.Database;
let ws: string;
let nodes: NodeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-nodes-'));
  db = openDb(join(dir, 'db.sqlite'));
  ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  nodes = new NodeStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const pane = () => {
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  return new PaneStore(db).create({ tab_id: tab, shell: '/bin/zsh', cwd: '/tmp' }).id;
};

describe('this machine is a row like any other', () => {
  it('exists after the migration, and is up — its link is a unix socket', () => {
    const local = nodes.get(LOCAL_NODE_ID);
    expect(local?.id).toBe(LOCAL_NODE_ID);
    expect(local?.state).toBe('up');
    expect(local?.endpoint).toBe(null); // needs no link
  });

  it('cannot be removed — a cockpit cannot be configured out of existence', () => {
    expect(nodes.remove(LOCAL_NODE_ID)).toBe(false);
    expect(nodes.get(LOCAL_NODE_ID)).not.toBe(null);
  });

  it('sorts first, so the machine you look for least is predictably placed', () => {
    nodes.add({ id: 'aaa', name: 'aaa', endpoint: 'wss://a' });
    expect(nodes.list()[0]?.id).toBe(LOCAL_NODE_ID);
  });
});

describe('every pane resolves to a machine', () => {
  it('an existing pane reads as local — the pre-migration meaning', () => {
    expect(nodes.nodeForPane(pane())).toBe(LOCAL_NODE_ID);
  });

  it('an UNKNOWN pane resolves to local rather than null', () => {
    // Callers must not need a null branch; two spellings of "here" is how two
    // call sites end up acting on different machines.
    expect(nodes.nodeForPane('01NOPENOPENOPENOPENOPENOPE')).toBe(LOCAL_NODE_ID);
  });

  it('counts panes per machine', () => {
    pane();
    pane();
    expect(nodes.paneCounts().get(LOCAL_NODE_ID)).toBe(2);
  });
});

describe('the rail stays unchanged until there IS a second machine', () => {
  it('is not multi-node with only local', () => {
    expect(nodes.isMultiNode()).toBe(false);
  });
  it('…and is as soon as one is added', () => {
    nodes.add({ id: 'trayo', name: 'Trayo VM', endpoint: 'wss://vm:7797' });
    expect(nodes.isMultiNode()).toBe(true);
  });
});

describe('state is the LINK, not the machine', () => {
  it('last_seen moves only on up', () => {
    nodes.add({ id: 'n', name: 'n', endpoint: 'wss://n' });
    nodes.setState('n', 'down', 1_000);
    expect(nodes.get('n')?.last_seen).toBe(null); // a failed attempt is not a reply
    nodes.setState('n', 'up', 2_000);
    expect(nodes.get('n')?.last_seen).toBe(2_000);
    nodes.setState('n', 'down', 3_000);
    expect(nodes.get('n')?.last_seen).toBe(2_000); // still the last real answer
  });

  it('unauthorized is distinct from down, because the user must act on it', () => {
    nodes.add({ id: 'n', name: 'n', endpoint: 'wss://n' });
    nodes.setState('n', 'unauthorized');
    expect(nodes.get('n')?.state).toBe('unauthorized');
  });

  it('a stored up is NOT believed after a restart', () => {
    // It describes a socket that cannot have survived the process. Showing a
    // machine as reachable until something fails is the one thing a badge
    // must not do.
    nodes.add({ id: 'n', name: 'n', endpoint: 'wss://n' });
    nodes.setState('n', 'up');
    nodes.resetLinkStates();
    expect(nodes.get('n')?.state).toBe('unknown');
    expect(nodes.get(LOCAL_NODE_ID)?.state).toBe('up'); // …except here
  });

  it('an unrecognised stored state reads as unknown, never garbage', () => {
    nodes.add({ id: 'n', name: 'n', endpoint: 'wss://n' });
    db.prepare("UPDATE nodes SET state = 'banana' WHERE id = 'n'").run();
    expect(nodes.get('n')?.state).toBe('unknown');
  });
});

describe('where a new chat is created', () => {
  it('local when the workspace names no default', () => {
    expect(nodes.defaultNodeFor(ws)).toBe(LOCAL_NODE_ID);
  });

  it('the workspace default when it names one', () => {
    nodes.add({ id: 'trayo', name: 'Trayo VM', endpoint: 'wss://vm' });
    nodes.setDefaultNodeFor(ws, 'trayo');
    expect(nodes.defaultNodeFor(ws)).toBe('trayo');
  });

  it('falls back to local when the default node was REMOVED', () => {
    // A node deleted out from under a workspace must not make "new chat"
    // fail; it must make it land here.
    nodes.add({ id: 'trayo', name: 'Trayo VM', endpoint: 'wss://vm' });
    nodes.setDefaultNodeFor(ws, 'trayo');
    nodes.remove('trayo');
    expect(nodes.defaultNodeFor(ws)).toBe(LOCAL_NODE_ID);
  });

  it('and for an unknown workspace, rather than throwing', () => {
    expect(nodes.defaultNodeFor('01NOSUCHWORKSPACE0000000AB')).toBe(LOCAL_NODE_ID);
  });
});
