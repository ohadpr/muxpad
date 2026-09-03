import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';
import { AppStore } from '../store/AppStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import {
  APPS_WORKSPACE_KEY,
  type AppRegistry,
  MATERIALIZE_COOLDOWN_MS,
  appStartupCmd,
  createAppRegistry,
  startAppReconciler,
} from './AppRegistry.js';

/** A ptyd that records what it was asked to do and can be told to fail. */
function fakePtyd() {
  const ensured: PaneRuntimeSpec[] = [];
  const killed: string[] = [];
  const state = { ensureThrows: false, killThrows: false };
  return {
    ensured,
    killed,
    state,
    ensurePane: async (spec: PaneRuntimeSpec) => {
      if (state.ensureThrows) throw new Error('ptyd unreachable');
      ensured.push(spec);
    },
    killPane: async (id: string) => {
      if (state.killThrows) throw new Error('ptyd unreachable');
      killed.push(id);
    },
  };
}

let db: Database.Database;
let ptyd: ReturnType<typeof fakePtyd>;
let apps: AppStore;
let panes: PaneStore;
let tabs: TabStore;
let workspaces: WorkspaceStore;
let registry: AppRegistry;
let clock: number;
let connectedFns: Array<() => void>;

function makeApp(over: Partial<Parameters<AppStore['create']>[0]> = {}) {
  return apps.create({
    slug: 'notes',
    name: 'Notes',
    cwd: '/tmp',
    command: './start',
    url: 'http://127.0.0.1:4322',
    ...over,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  ptyd = fakePtyd();
  apps = new AppStore(db);
  panes = new PaneStore(db);
  tabs = new TabStore(db);
  workspaces = new WorkspaceStore(db);
  clock = 1_000_000;
  connectedFns = [];
  registry = createAppRegistry({
    db,
    ptyd,
    defaultShell: '/bin/zsh',
    now: () => clock,
    log: () => {},
  });
});

describe('appStartupCmd', () => {
  it('keeps the `muxpad serve` prefix the supervisor sweeps on', () => {
    const cmd = appStartupCmd({ url: 'http://127.0.0.1:1', name: 'Notes', command: './start' });
    expect(cmd.startsWith('muxpad serve')).toBe(true);
    expect(cmd).toBe("muxpad serve --url 'http://127.0.0.1:1' --label 'Notes' -- ./start");
  });

  it('strips quote/newline/semicolon out of the label so it cannot break the line', () => {
    const cmd = appStartupCmd({
      url: 'http://127.0.0.1:1',
      name: "Ev'il\n; rm -rf /",
      command: './start',
    });
    expect(cmd).toBe("muxpad serve --url 'http://127.0.0.1:1' --label 'Evil rm -rf /' -- ./start");
  });
});

describe('the hidden container', () => {
  it('is created once, hidden, and stays out of the visible workspace list', () => {
    const id = registry.containerId();
    expect(registry.containerId()).toBe(id);
    const ws = workspaces.getById(id);
    expect(ws?.hidden).toBe(true);
    expect(workspaces.list().map((w) => w.id)).not.toContain(id);
    expect(workspaces.list({ all: true }).map((w) => w.id)).toContain(id);
    expect(new GlobalsStore(db).get(APPS_WORKSPACE_KEY)).toBe(id);
  });

  it('rebuilds itself if the pointer goes stale', () => {
    const first = registry.containerId();
    workspaces.delete(first);
    const second = registry.containerId();
    expect(second).not.toBe(first);
    expect(workspaces.getById(second)?.hidden).toBe(true);
  });
});

describe('materialize', () => {
  it('creates a tab + pane in the hidden container and spawns the pty', async () => {
    const app = makeApp();
    await registry.materialize(app.id);
    const fresh = apps.getById(app.id);
    expect(fresh?.pane_id).toBeTruthy();
    const pane = panes.getById(fresh?.pane_id as string);
    expect(pane?.startup_cmd).toBe(appStartupCmd(app));
    expect(pane?.face).toBe('web');
    expect(pane?.face_url).toBe(app.url);
    // In the hidden container, so no navigator surface can reach it.
    const tab = tabs.getById(pane?.tab_id as string);
    expect(tabs.getWorkspaceId(tab?.id as string)).toBe(registry.containerId());
    expect(ptyd.ensured.map((s) => s.id)).toEqual([pane?.id]);
  });

  it('is idempotent — a second call does not create a second pane', async () => {
    const app = makeApp();
    await registry.materialize(app.id);
    const paneId = apps.getById(app.id)?.pane_id;
    clock += MATERIALIZE_COOLDOWN_MS * 5;
    await registry.materialize(app.id);
    expect(apps.getById(app.id)?.pane_id).toBe(paneId);
    expect(ptyd.ensured).toHaveLength(1);
  });

  it('keeps the rows when ptyd is unreachable, so the supervisor can finish', async () => {
    ptyd.state.ensureThrows = true;
    const app = makeApp();
    await registry.materialize(app.id);
    const fresh = apps.getById(app.id);
    expect(fresh?.pane_id).toBeTruthy();
    expect(panes.getById(fresh?.pane_id as string)).not.toBeNull();
  });

  it('will not build a second pane inside the cooldown', async () => {
    const app = makeApp();
    await registry.materialize(app.id);
    const paneId = apps.getById(app.id)?.pane_id as string;
    // Simulate the pathological case the cooldown exists for: the pane row
    // vanishes and something calls materialize again immediately.
    panes.delete(paneId);
    apps.setPane(app.id, null);
    clock += 1;
    await registry.materialize(app.id);
    expect(apps.getById(app.id)?.pane_id).toBeNull();
    // Past the cooldown it proceeds normally.
    clock += MATERIALIZE_COOLDOWN_MS;
    await registry.materialize(app.id);
    expect(apps.getById(app.id)?.pane_id).toBeTruthy();
  });
});

describe('start / stop / remove', () => {
  it('stop disables BEFORE tearing down, kills the pty and drops the tab', async () => {
    const app = makeApp();
    await registry.start(app.id);
    const paneId = apps.getById(app.id)?.pane_id as string;
    const tabId = panes.getById(paneId)?.tab_id as string;

    // The supervisor's skip rule needs BOTH halves of
    // `enabled = 0 AND pane_id = P`. Assert BOTH at the only instant that
    // matters — while the kill is in flight — because an earlier draft cleared
    // `pane_id` first, which satisfied the assertion on `enabled` while making
    // the rule match nothing, and a sweep in that window resurrected the pty we
    // were killing into an unreachable orphan.
    const seen: Array<{ enabled: boolean; pointer: string | null; swept: boolean }> = [];
    const spy = vi.spyOn(ptyd, 'killPane').mockImplementation(async (id: string) => {
      const row = apps.getById(app.id);
      seen.push({
        enabled: row?.enabled === true,
        pointer: row?.pane_id ?? null,
        // The decisive check: is the supervisor's own query still offering this
        // pane up for respawn right now?
        swept: panes.listServePanes().some((p) => p.id === paneId),
      });
      ptyd.killed.push(id);
    });
    await registry.stop(app.id);
    spy.mockRestore();

    expect(seen).toEqual([{ enabled: false, pointer: paneId, swept: false }]);
    expect(ptyd.killed).toEqual([paneId]);
    expect(apps.getById(app.id)?.enabled).toBe(false);
    expect(apps.getById(app.id)?.pane_id).toBeNull();
    expect(panes.getById(paneId)).toBeNull();
    expect(tabs.getById(tabId)).toBeNull();
  });

  it('start after stop builds a fresh pane', async () => {
    const app = makeApp();
    await registry.start(app.id);
    const first = apps.getById(app.id)?.pane_id;
    await registry.stop(app.id);
    clock += MATERIALIZE_COOLDOWN_MS;
    await registry.start(app.id);
    const second = apps.getById(app.id)?.pane_id;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(apps.getById(app.id)?.enabled).toBe(true);
  });

  it('queues the kill for the reaper when ptyd is unreachable, and still tears down', async () => {
    const app = makeApp();
    await registry.start(app.id);
    const paneId = apps.getById(app.id)?.pane_id as string;
    ptyd.state.killThrows = true;
    await registry.stop(app.id);
    expect(panes.getById(paneId)).toBeNull();
    const queued = db.prepare('SELECT pane_id FROM pending_pane_kills').all() as Array<{
      pane_id: string;
    }>;
    expect(queued.map((r) => r.pane_id)).toContain(paneId);
  });

  it('remove tears the pane down before deleting the row (never an orphan pty)', async () => {
    const app = makeApp();
    await registry.start(app.id);
    const paneId = apps.getById(app.id)?.pane_id as string;
    expect(await registry.remove(app.id)).toBe(true);
    expect(apps.getById(app.id)).toBeNull();
    expect(panes.getById(paneId)).toBeNull();
    expect(ptyd.killed).toContain(paneId);
    expect(await registry.remove(app.id)).toBe(false);
  });
});

describe('reconcile', () => {
  it('brings up an enabled app that has no pane', async () => {
    const app = makeApp();
    expect(apps.getById(app.id)?.pane_id).toBeNull();
    await registry.reconcile();
    expect(apps.getById(app.id)?.pane_id).toBeTruthy();
  });

  it('rebuilds an app whose pane row vanished', async () => {
    const app = makeApp();
    await registry.reconcile();
    const first = apps.getById(app.id)?.pane_id as string;
    panes.delete(first);
    clock += MATERIALIZE_COOLDOWN_MS;
    await registry.reconcile();
    const second = apps.getById(app.id)?.pane_id;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('leaves a healthy app completely alone (no churn on repeat sweeps)', async () => {
    const app = makeApp();
    await registry.reconcile();
    const paneId = apps.getById(app.id)?.pane_id;
    for (let i = 0; i < 5; i++) {
      clock += MATERIALIZE_COOLDOWN_MS;
      await registry.reconcile();
    }
    expect(apps.getById(app.id)?.pane_id).toBe(paneId);
    expect(ptyd.ensured).toHaveLength(1);
    expect(ptyd.killed).toHaveLength(0);
  });

  it('never starts a stopped app, and reaps a pane a crash left behind', async () => {
    const app = makeApp();
    await registry.start(app.id);
    const paneId = apps.getById(app.id)?.pane_id as string;
    // Simulate a crash between `enabled = 0` and the teardown.
    apps.update(app.id, { enabled: false });
    await registry.reconcile();
    expect(panes.getById(paneId)).toBeNull();
    expect(apps.getById(app.id)?.pane_id).toBeNull();
    // And it stays down on every later sweep.
    clock += MATERIALIZE_COOLDOWN_MS;
    await registry.reconcile();
    expect(apps.getById(app.id)?.pane_id).toBeNull();
  });

  it('boot: autostart=0 lands the app in an honest `stopped`, not enabled-but-paneless', async () => {
    const app = makeApp({ autostart: false });
    await registry.reconcile({ boot: true });
    const fresh = apps.getById(app.id);
    expect(fresh?.enabled).toBe(false);
    expect(fresh?.pane_id).toBeNull();
    // A later non-boot reconcile must not undo that decision.
    clock += MATERIALIZE_COOLDOWN_MS;
    await registry.reconcile();
    expect(apps.getById(app.id)?.enabled).toBe(false);
    // …but an explicit start still works.
    await registry.start(app.id);
    expect(apps.getById(app.id)?.pane_id).toBeTruthy();
  });

  it('boot: autostart=1 comes straight back up', async () => {
    const app = makeApp({ autostart: true });
    await registry.reconcile({ boot: true });
    expect(apps.getById(app.id)?.enabled).toBe(true);
    expect(apps.getById(app.id)?.pane_id).toBeTruthy();
  });

  it('is single-flight — concurrent calls do not double-materialize', async () => {
    makeApp();
    await Promise.all([registry.reconcile(), registry.reconcile(), registry.reconcile()]);
    expect(ptyd.ensured).toHaveLength(1);
  });

  it('survives ptyd being down and finishes the job when it returns', async () => {
    ptyd.state.ensureThrows = true;
    const app = makeApp();
    await registry.reconcile();
    // Rows exist (so the serve supervisor can adopt it) even though no pty does.
    expect(apps.getById(app.id)?.pane_id).toBeTruthy();
    ptyd.state.ensureThrows = false;
    clock += MATERIALIZE_COOLDOWN_MS;
    await registry.reconcile();
    // No SECOND pane: the row is intact, so reconcile has nothing to rebuild.
    expect(
      panes.listByTab(panes.getById(apps.getById(app.id)?.pane_id as string)?.tab_id as string),
    ).toHaveLength(1);
  });
});

describe('startAppReconciler', () => {
  it('repairs on an interval, not only when ptyd reconnects', async () => {
    // The hole this closes: an app's pane can be destroyed by paths that know
    // nothing about the registry (DELETE /api/panes/:id, a tab-delete cascade,
    // a hand-run SQL fix). Reconciling only on ptyd's reconnect would leave the
    // app down — while reporting `starting` — until the next daemon restart,
    // which on a healthy machine is days.
    const connected: Array<() => void> = [];
    const app = makeApp();
    const handle = startAppReconciler({
      db,
      ptyd,
      registry,
      intervalMs: 20,
      onPtydConnected: (fn) => {
        connected.push(fn);
        return () => {};
      },
    });
    // Boot pass materialised it.
    await new Promise((r) => setTimeout(r, 30));
    const first = apps.getById(app.id)?.pane_id as string;
    expect(first).toBeTruthy();

    // Something else deletes the pane. No ptyd event fires.
    panes.delete(first);
    clock += MATERIALIZE_COOLDOWN_MS;
    await new Promise((r) => setTimeout(r, 80));

    const second = apps.getById(app.id)?.pane_id;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    handle.stop();
  });

  it('stops for real — no pass survives stop()', async () => {
    const app = makeApp();
    const detached: string[] = [];
    const handle = startAppReconciler({
      db,
      ptyd,
      registry,
      intervalMs: 10,
      onPtydConnected: (fn) => {
        // Hand the listener back so we can prove a late reconnect is ignored.
        connectedFns.push(fn);
        return () => detached.push('detached');
      },
    });
    await new Promise((r) => setTimeout(r, 25));
    handle.stop();
    expect(detached).toEqual(['detached']);

    const paneId = apps.getById(app.id)?.pane_id as string;
    panes.delete(paneId);
    apps.setPane(app.id, null);
    clock += MATERIALIZE_COOLDOWN_MS;
    // A 'connected' emit already in flight when stop() ran must also be inert.
    for (const fn of connectedFns) fn();
    await new Promise((r) => setTimeout(r, 60));
    expect(apps.getById(app.id)?.pane_id).toBeNull();
  });

  it('applies the autostart translation ONCE, at boot, not on every repair', async () => {
    const app = makeApp({ autostart: false });
    const handle = startAppReconciler({ db, ptyd, registry, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 40));
    // Boot left it honestly stopped…
    expect(apps.getById(app.id)?.enabled).toBe(false);
    // …and an explicit start is not undone by the next repair pass, which is
    // what a `boot: true` on every tick would have done.
    await registry.start(app.id);
    expect(apps.getById(app.id)?.pane_id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 60));
    expect(apps.getById(app.id)?.enabled).toBe(true);
    expect(apps.getById(app.id)?.pane_id).toBeTruthy();
    handle.stop();
  });
});

describe('appStartupCmd is the choke point, not a formality', () => {
  it('strips a quote out of the URL even when the row was written around the API', () => {
    // Rows can arrive from adoption or a hand-edited SQLite file. A quote here
    // escapes its own quoting and turns the rest of the line into shell.
    const cmd = appStartupCmd({
      url: "http://x/';touch /tmp/pwned;'",
      name: 'X',
      command: './start',
    });
    expect(cmd).not.toContain("';");
    expect(cmd).toBe("muxpad serve --url 'http://x/touch /tmp/pwned' --label 'X' -- ./start");
  });
});

describe('the container does not accumulate empty tabs', () => {
  it('collects the tab a vanished pane left behind', async () => {
    const app = makeApp();
    await registry.reconcile();
    const first = apps.getById(app.id)?.pane_id as string;
    const firstTab = panes.getById(first)?.tab_id as string;

    // The pane row vanishes; the rebuild makes a FRESH tab, so without a
    // collector the old one would linger invisibly in the container forever —
    // one more per rebuild.
    panes.delete(first);
    clock += MATERIALIZE_COOLDOWN_MS;
    await registry.reconcile();

    expect(tabs.getById(firstTab)).toBeNull();
    expect(tabs.listByWorkspace(registry.containerId())).toHaveLength(1);
  });
});
