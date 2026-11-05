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

/**
 * PAIRING MUST NOT NEED A RESTART.
 *
 * A restart is the one operation the user is told not to do casually — it
 * drops every runner's socket — so "add a machine, then restart muxpad" would
 * have made the paired flow worse than wiring it by hand.
 */
describe('syncing links to the table', () => {
  it('dials a machine added after start', () => {
    const made: string[] = [];
    const links = new NodeLinks({
      nodes,
      dataDir: dir,
      makeClient: (o) => {
        made.push(o.controlUrl);
        return fakeClient();
      },
      log: () => {},
    });
    links.start();
    expect(made).toEqual([]);
    nodes.add({ id: 'trayo', name: 'VM', endpoint: 'ws://vm:7797' });
    withToken('trayo');
    links.sync();
    expect(made).toEqual(['ws://vm:7797/control']);
  });

  it('closes one that was removed', async () => {
    nodes.add({ id: 'trayo', name: 'VM', endpoint: 'ws://vm:7797' });
    withToken('trayo');
    const client = fakeClient();
    const links = new NodeLinks({ nodes, dataDir: dir, makeClient: () => client, log: () => {} });
    links.start();
    client.fire('connected');
    expect(links.isUp('trayo')).toBe(true);
    nodes.remove('trayo');
    links.sync();
    expect(client.close).toHaveBeenCalled();
    expect(links.get('trayo')).toBe(null);
  });

  it('REDIALS one that was re-pointed, rather than keeping the old address', async () => {
    // The open client is pointed at a machine that is no longer the answer;
    // leaving it would make a corrected endpoint look like it did nothing.
    nodes.add({ id: 'trayo', name: 'VM', endpoint: 'ws://old:7797' });
    withToken('trayo');
    const made: string[] = [];
    const clients: Array<ReturnType<typeof fakeClient>> = [];
    const links = new NodeLinks({
      nodes,
      dataDir: dir,
      makeClient: (o) => {
        made.push(o.controlUrl);
        const c = fakeClient();
        clients.push(c);
        return c;
      },
      log: () => {},
    });
    links.start();
    nodes.update('trayo', { endpoint: 'ws://new:7797' });
    links.sync();
    expect(made).toEqual(['ws://old:7797/control', 'ws://new:7797/control']);
    expect(clients[0]?.close).toHaveBeenCalled();
  });

  it('is idempotent — an unchanged table redials nothing', () => {
    nodes.add({ id: 'trayo', name: 'VM', endpoint: 'ws://vm:7797' });
    withToken('trayo');
    const made: string[] = [];
    const links = new NodeLinks({
      nodes,
      dataDir: dir,
      makeClient: (o) => {
        made.push(o.controlUrl);
        return fakeClient();
      },
      log: () => {},
    });
    links.start();
    links.sync();
    links.sync();
    expect(made).toHaveLength(1);
  });
});
