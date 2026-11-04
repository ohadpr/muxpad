import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';
import { LOCAL_NODE_ID, NodeStore } from '../store/NodeStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import {
  NodeUnavailableError,
  type PaneOps,
  PaneRouter,
  type PaneTransport,
  UnknownNodeError,
} from './PaneRouter.js';

let dir: string;
let db: Database.Database;
let ws: string;
let nodes: NodeStore;

const fakeTransport = (name: string): PaneOps & { name: string } => ({
  name,
  // The local slot needs the event/shutdown surface too; remotes only ever
  // have their pane methods called, so the extras are harmless noise there.
  on: vi.fn(),
  off: vi.fn(),
  close: vi.fn(async () => {}),
  ensurePane: vi.fn(async () => {}),
  killPane: vi.fn(async () => {}),
  hasPane: vi.fn(async () => true),
  listPanes: vi.fn(async () => [`${name}-pane`]),
  getCurrentCwd: vi.fn(async () => `/${name}`),
  getForegroundCommand: vi.fn(async () => name),
  markSeen: vi.fn(async () => {}),
  closePtyClients: vi.fn(async () => {}),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-router-'));
  db = openDb(join(dir, 'db.sqlite'));
  ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  nodes = new NodeStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const pane = (nodeId = LOCAL_NODE_ID) => {
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  const id = new PaneStore(db).create({ tab_id: tab, shell: '/bin/zsh', cwd: '/tmp' }).id;
  db.prepare('UPDATE panes SET node_id = ? WHERE id = ?').run(nodeId, id);
  return id;
};

const spec = (id: string): PaneRuntimeSpec => ({ id, shell: '/bin/zsh', cwd: '/tmp' });

describe('a pane goes to the machine that owns it', () => {
  it('local panes go local', async () => {
    const local = fakeTransport('local');
    const r = new PaneRouter({ local, nodes, remote: () => null });
    await r.killPane(pane());
    expect(local.killPane).toHaveBeenCalled();
  });

  it('remote panes go to that node, never to local', async () => {
    const local = fakeTransport('local');
    const trayo = fakeTransport('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    const r = new PaneRouter({ local, nodes, remote: () => trayo });
    const p = pane('trayo');
    await r.killPane(p);
    expect(trayo.killPane).toHaveBeenCalledWith(p);
    expect(local.killPane).not.toHaveBeenCalled();
  });
});

/**
 * ── THE RULE THE WHOLE CLASS EXISTS FOR ──────────────────────────────────
 * When a node's link is down we do NOT know what is running there — the pane
 * is probably alive. `false` is the answer that authorises destruction, so an
 * unreachable node must throw instead.
 */
describe('unavailable is not absent', () => {
  const downRouter = () => {
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    return new PaneRouter({ local: fakeTransport('local'), nodes, remote: () => null });
  };

  it('hasPane THROWS rather than saying the pane is gone', async () => {
    // This is the one that recreates a live conversation on the mac.
    await expect(downRouter().hasPane(pane('trayo'))).rejects.toBeInstanceOf(NodeUnavailableError);
  });

  it('kill, create and the rest throw too', async () => {
    const r = downRouter();
    const p = pane('trayo');
    for (const op of [
      () => r.killPane(p),
      () => r.ensurePane(spec(p)),
      () => r.markSeen(p),
      () => r.closePtyClients(p),
      () => r.getCurrentCwd(p),
      () => r.getForegroundCommand(p),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(NodeUnavailableError);
    }
  });

  it('NEVER silently falls back to the local transport', async () => {
    // A fallback here would be this exact bug one layer lower, where it is
    // much harder to see.
    const local = fakeTransport('local');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    const r = new PaneRouter({ local, nodes, remote: () => null });
    await expect(r.killPane(pane('trayo'))).rejects.toThrow();
    expect(local.killPane).not.toHaveBeenCalled();
    expect(local.ensurePane).not.toHaveBeenCalled();
  });

  it('names the node in the error, so a log says which machine', async () => {
    // `hasPane` resolves to boolean, so the caught value must be narrowed
    // explicitly rather than cast through the union.
    let caught: unknown;
    try {
      await downRouter().hasPane(pane('trayo'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NodeUnavailableError);
    expect((caught as NodeUnavailableError).nodeId).toBe('trayo');
    expect(String(caught)).toContain('trayo');
  });

  it('a pane naming a node that was REMOVED is a distinct error', async () => {
    // Not "unavailable" — there is nothing to wait for, and the two want
    // different handling.
    const r = new PaneRouter({ local: fakeTransport('l'), nodes, remote: () => null });
    await expect(r.hasPane(pane('ghost'))).rejects.toBeInstanceOf(UnknownNodeError);
  });
});

describe('a global sweep says where it could not look', () => {
  it('unions live nodes and reports none unreachable', async () => {
    const local = fakeTransport('local');
    const trayo = fakeTransport('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    const r = new PaneRouter({ local, nodes, remote: () => trayo });
    const { value, unreachable } = await r.listPanesBestEffort();
    expect(value.sort()).toEqual(['local-pane', 'trayo-pane']);
    expect(unreachable).toEqual([]);
    // …and the all-or-nothing form agrees when nothing is missing.
    expect((await r.listPanes()).sort()).toEqual(['local-pane', 'trayo-pane']);
  });

  it('a short list from a DOWN node is reported as partial, not as empty', async () => {
    // A reconciler reading "these are alive" off a silently short list would
    // conclude everything on the down node is dead — the same fatal confusion
    // as hasPane returning false.
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    const r = new PaneRouter({ local: fakeTransport('local'), nodes, remote: () => null });
    const { value, unreachable } = await r.listPanesBestEffort();
    expect(value).toEqual(['local-pane']);
    expect(unreachable).toEqual(['trayo']);
    // A RECONCILER must not get that short list at all — it would read it as
    // "everything on trayo is dead" and reap or recreate accordingly.
    await expect(r.listPanes()).rejects.toBeInstanceOf(NodeUnavailableError);
  });

  it('a node that ERRORS counts as unreachable, not as empty', async () => {
    const broken = {
      ...fakeTransport('trayo'),
      listPanes: vi.fn(async () => {
        throw new Error('socket closed mid-call');
      }),
    };
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    const r = new PaneRouter({ local: fakeTransport('local'), nodes, remote: () => broken });
    const { unreachable } = await r.listPanesBestEffort();
    expect(unreachable).toEqual(['trayo']);
  });
});

describe('creating on a named node, before any row exists', () => {
  it('uses the node the caller chose', async () => {
    const trayo = fakeTransport('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    const r = new PaneRouter({ local: fakeTransport('local'), nodes, remote: () => trayo });
    await r.ensurePaneOn('trayo', spec('p1'));
    expect(trayo.ensurePane).toHaveBeenCalled();
  });

  it('refuses to create on a node that is down', async () => {
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'wss://x' });
    const r = new PaneRouter({ local: fakeTransport('local'), nodes, remote: () => null });
    await expect(r.ensurePaneOn('trayo', spec('p1'))).rejects.toBeInstanceOf(NodeUnavailableError);
  });
});

/**
 * ── THE SHELL IS PART OF "WHICH MACHINE" ─────────────────────────────────
 * The same bug as the cwd, one field over: the server's default is
 * `/bin/zsh`, there is no zsh on a stock Ubuntu box, and a pane created with
 * it died the instant it started — reported as nothing but "the pty exited
 * immediately after starting".
 */
describe('a remote pane gets its own machine’s shell', () => {
  const specWithShell = (id: string, shell: string): PaneRuntimeSpec => ({
    id,
    shell,
    cwd: '/tmp',
  });

  const routerWith = (capabilities: unknown) => {
    const local = fakeTransport('local');
    const trayo = fakeTransport('trayo');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'ws://vm:7797' });
    if (capabilities !== undefined) nodes.setCapabilities('trayo', capabilities);
    return {
      trayo,
      router: new PaneRouter({ local, nodes, remote: () => trayo }),
    };
  };

  it('substitutes the host’s shell for the server’s default', async () => {
    const { trayo, router } = routerWith({ shell: '/bin/bash' });
    const p = pane('trayo');
    await router.ensurePane(specWithShell(p, process.env.SHELL ?? '/bin/zsh'));
    expect(
      (trayo.ensurePane as unknown as { mock: { calls: PaneRuntimeSpec[][] } }).mock.calls[0]?.[0]
        ?.shell,
    ).toBe('/bin/bash');
  });

  it('leaves a DELIBERATELY chosen shell alone', async () => {
    // Someone who typed a shell owns the consequence; silently replacing it
    // would make a wrong choice unfindable.
    const { trayo, router } = routerWith({ shell: '/bin/bash' });
    const p = pane('trayo');
    await router.ensurePane(specWithShell(p, '/usr/bin/fish'));
    expect(
      (trayo.ensurePane as unknown as { mock: { calls: PaneRuntimeSpec[][] } }).mock.calls[0]?.[0]
        ?.shell,
    ).toBe('/usr/bin/fish');
  });

  it('changes nothing when the host has not described itself', async () => {
    const { trayo, router } = routerWith(undefined);
    const p = pane('trayo');
    const asked = process.env.SHELL ?? '/bin/zsh';
    await router.ensurePane(specWithShell(p, asked));
    expect(
      (trayo.ensurePane as unknown as { mock: { calls: PaneRuntimeSpec[][] } }).mock.calls[0]?.[0]
        ?.shell,
    ).toBe(asked);
  });

  it('ignores a relative shell — that is not a shell choice', async () => {
    const { trayo, router } = routerWith({ shell: 'bash' });
    const p = pane('trayo');
    const asked = process.env.SHELL ?? '/bin/zsh';
    await router.ensurePane(specWithShell(p, asked));
    expect(
      (trayo.ensurePane as unknown as { mock: { calls: PaneRuntimeSpec[][] } }).mock.calls[0]?.[0]
        ?.shell,
    ).toBe(asked);
  });

  it('never touches a LOCAL pane’s shell', async () => {
    const local = fakeTransport('local');
    nodes.add({ id: 'trayo', name: 'Trayo', endpoint: 'ws://vm:7797' });
    nodes.setCapabilities('trayo', { shell: '/bin/bash' });
    const r = new PaneRouter({ local, nodes, remote: () => null });
    const p = pane();
    await r.ensurePane(specWithShell(p, '/bin/zsh'));
    expect(
      (local.ensurePane as unknown as { mock: { calls: PaneRuntimeSpec[][] } }).mock.calls[0]?.[0]
        ?.shell,
    ).toBe('/bin/zsh');
  });
});
