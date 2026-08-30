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

    const order: string[] = [];
    const spy = vi.spyOn(ptyd, 'killPane').mockImplementation(async (id: string) => {
      // By the time the kill goes out, the row must already read disabled —
      // otherwise a supervisor sweep in this window respawns what we just killed.
      order.push(apps.getById(app.id)?.enabled ? 'enabled' : 'disabled');
      ptyd.killed.push(id);
    });
    await registry.stop(app.id);
    spy.mockRestore();

    expect(order).toEqual(['disabled']);
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
