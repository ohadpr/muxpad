import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeStore } from '../store/NodeStore.js';
import { openDb } from '../store/db.js';
import { NodeLinks, readNodeTokenFor } from './NodeLinks.js';

let dir: string;
let db: Database.Database;
let nodes: NodeStore;
const TOKEN = 'a'.repeat(64);

const fakeClient = () => {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    fire: (e: string) => handlers.get(e)?.(),
    on: vi.fn((e: string, f: () => void) => handlers.set(e, f)),
    close: vi.fn(async () => {}),
    ensurePane: vi.fn(async () => {}),
    killPane: vi.fn(async () => {}),
    hasPane: vi.fn(async () => true),
    listPanes: vi.fn(async () => []),
    getCurrentCwd: vi.fn(async () => null),
    getForegroundCommand: vi.fn(async () => null),
    markSeen: vi.fn(async () => {}),
    closePtyClients: vi.fn(async () => {}),
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-links-'));
  db = openDb(join(dir, 'db.sqlite'));
  nodes = new NodeStore(db);
  mkdirSync(join(dir, 'node-tokens'), { recursive: true });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const withToken = (id: string) => writeFileSync(join(dir, 'node-tokens', id), `${TOKEN}\n`);

describe('the token on this machine', () => {
  it('is read per call, and a stub file is not a credential', () => {
    expect(readNodeTokenFor('trayo', dir)).toBe(null);
    writeFileSync(join(dir, 'node-tokens', 'trayo'), 'tooshort\n');
    expect(readNodeTokenFor('trayo', dir)).toBe(null);
    withToken('trayo');
    expect(readNodeTokenFor('trayo', dir)).toBe(TOKEN);
  });
});

describe('opening links', () => {
  it('skips local — its ptyd is a unix socket, not a link', () => {
    const make = vi.fn(fakeClient);
    new NodeLinks({ nodes, dataDir: dir, makeClient: make, log: () => {} }).start();
    expect(make).not.toHaveBeenCalled();
  });

  it('opens one per remote node and reports up on connect', () => {
    withToken('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'ws://vm:7797' });
    const c = fakeClient();
    const links = new NodeLinks({
      nodes,
      dataDir: dir,
      makeClient: () => c,
      log: () => {},
    });
    links.start();
    expect(links.get('trayo')).toBe(null); // not connected yet
    expect(links.isUp('trayo')).toBe(false);
    c.fire('connected');
    expect(links.get('trayo')).toBe(c);
    expect(nodes.get('trayo')?.state).toBe('up');
  });

  it('a disconnect flips it back to down and withdraws the transport', () => {
    withToken('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'ws://vm:7797' });
    const c = fakeClient();
    const links = new NodeLinks({ nodes, dataDir: dir, makeClient: () => c, log: () => {} });
    links.start();
    c.fire('connected');
    c.fire('disconnected');
    expect(links.get('trayo')).toBe(null);
    expect(nodes.get('trayo')?.state).toBe('down');
  });

  it('a node with NO TOKEN is unauthorized, not down', () => {
    // It is a setup step the user has to finish. Rendering it as merely
    // offline hides that there is something to do.
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'ws://vm:7797' });
    const make = vi.fn(fakeClient);
    new NodeLinks({ nodes, dataDir: dir, makeClient: make, log: () => {} }).start();
    expect(nodes.get('trayo')?.state).toBe('unauthorized');
    expect(make).not.toHaveBeenCalled(); // no point dialling without one
  });

  it('builds /control onto the endpoint, tolerating a trailing slash', () => {
    withToken('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'ws://vm:7797/' });
    const seen: string[] = [];
    new NodeLinks({
      nodes,
      dataDir: dir,
      makeClient: (o) => {
        seen.push(o.controlUrl);
        return fakeClient();
      },
      log: () => {},
    }).start();
    expect(seen).toEqual(['ws://vm:7797/control']);
  });
});

/**
 * ── NULL, NOT A DEAD CLIENT ──────────────────────────────────────────────
 * Handing back a client whose socket is down turns "unreachable" into a pile
 * of per-call errors at the far end of the stack. Returning null lets
 * PaneRouter raise the one error that means what it says — and "I cannot see
 * that machine" must never be answerable as "that pane is gone".
 */
describe('a down node yields no transport at all', () => {
  it('get() is null before connect and after disconnect', () => {
    withToken('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'ws://vm:7797' });
    const c = fakeClient();
    const links = new NodeLinks({ nodes, dataDir: dir, makeClient: () => c, log: () => {} });
    links.start();
    expect(links.get('trayo')).toBe(null);
    c.fire('connected');
    expect(links.get('trayo')).not.toBe(null);
    c.fire('disconnected');
    expect(links.get('trayo')).toBe(null);
  });

  it('an unconfigured node is null, never a guess', () => {
    const links = new NodeLinks({ nodes, dataDir: dir, log: () => {} });
    expect(links.get('nope')).toBe(null);
  });
});
