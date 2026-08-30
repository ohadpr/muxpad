import type { App, UrlHealth } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { AppStore } from '../store/AppStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { APP_STARTUP_GRACE_MS, createAppStatusProbe, deriveAppState } from './AppStatus.js';

const OK: UrlHealth = { alive: true, status: 200, reason: 'ok', elapsedMs: 3 };
const GATEWAY: UrlHealth = { alive: false, status: 502, reason: 'gateway', elapsedMs: 3 };

describe('deriveAppState', () => {
  const base = {
    enabled: true,
    gaveUp: false,
    pty: true as boolean | null,
    health: OK,
    withinStartupGrace: false,
  };

  it('the user`s decision outranks every observation', () => {
    expect(deriveAppState({ ...base, enabled: false })).toBe('stopped');
    // Even a dead probe on a stopped app is `stopped`, not `unreachable` —
    // nothing is supposed to be answering.
    expect(deriveAppState({ ...base, enabled: false, health: GATEWAY, pty: false })).toBe(
      'stopped',
    );
  });

  it('gave_up outranks liveness (no pty is the thing it gave up on)', () => {
    expect(deriveAppState({ ...base, gaveUp: true, pty: false, health: null })).toBe('gave_up');
  });

  it('no pty means starting — the supervisor is already on it', () => {
    expect(deriveAppState({ ...base, pty: false, health: null })).toBe('starting');
  });

  it('reports running when the URL answers', () => {
    expect(deriveAppState({ ...base })).toBe('running');
  });

  it('a proxy 502 is unreachable, not running — the case a browser cannot see', () => {
    expect(deriveAppState({ ...base, health: GATEWAY })).toBe('unreachable');
  });

  it('the startup grace keeps a legitimate boot from flashing a failure', () => {
    expect(deriveAppState({ ...base, health: GATEWAY, withinStartupGrace: true })).toBe('starting');
  });

  it('an unreachable ptyd is UNKNOWN, never manufactured into a failure', () => {
    // pty === null and the app answers → running. The daemon being unreachable
    // says nothing about the app.
    expect(deriveAppState({ ...base, pty: null })).toBe('running');
    expect(deriveAppState({ ...base, pty: null, health: GATEWAY })).toBe('unreachable');
  });

  it('not probed yet is starting, not unreachable', () => {
    expect(deriveAppState({ ...base, health: null })).toBe('starting');
  });
});

function fixture() {
  const db = openDb(':memory:');
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const apps = new AppStore(db);
  const ws = workspaces.createHidden({ name: '· apps ·' });
  const tab = tabs.create({ name: 'T', layout: '', workspace_id: ws.id });
  const pane = panes.create({
    tab_id: tab.id,
    shell: '/bin/zsh',
    cwd: '/tmp',
    startup_cmd: 'muxpad serve --url http://127.0.0.1:1 -- ./start',
  });
  const app = apps.create({
    slug: 'notes',
    name: 'Notes',
    cwd: '/tmp',
    command: './start',
    url: 'http://127.0.0.1:1',
  });
  apps.setPane(app.id, pane.id);
  return { db, apps, panes, pane, app: apps.getById(app.id) as App };
}

describe('createAppStatusProbe', () => {
  it('measures both signals and folds them into one state', async () => {
    const f = fixture();
    // Push the pane out of its startup grace so the probe is what decides.
    f.db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(1, f.pane.id);
    const probe = createAppStatusProbe({
      db: f.db,
      ptyd: { hasPane: async () => true },
      probe: async () => OK,
    });
    const s = await probe.status(f.app);
    expect(s.state).toBe('running');
    expect(s.pty).toBe(true);
    expect(s.health).toEqual(OK);
    f.db.close();
  });

  it('reports gave_up straight from the supervisor ledger', async () => {
    const f = fixture();
    f.db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(1, f.pane.id);
    const probe = createAppStatusProbe({
      db: f.db,
      ptyd: { hasPane: async () => false },
      probe: async () => GATEWAY,
      gaveUp: (id) => id === f.pane.id,
    });
    expect((await probe.status(f.app)).state).toBe('gave_up');
    f.db.close();
  });

  it('a throwing ptyd is UNKNOWN liveness, not a dead app', async () => {
    const f = fixture();
    f.db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(1, f.pane.id);
    const probe = createAppStatusProbe({
      db: f.db,
      ptyd: {
        hasPane: async () => {
          throw new Error('socket down');
        },
      },
      probe: async () => OK,
    });
    const s = await probe.status(f.app);
    expect(s.pty).toBeNull();
    expect(s.state).toBe('running');
    f.db.close();
  });

  it('an app with no pane is definitely not running', async () => {
    const f = fixture();
    f.apps.setPane(f.app.id, null);
    const app = f.apps.getById(f.app.id) as App;
    const probe = createAppStatusProbe({
      db: f.db,
      ptyd: {
        hasPane: async () => {
          throw new Error('should not be asked');
        },
      },
      probe: async () => GATEWAY,
    });
    const s = await probe.status(app);
    expect(s.pty).toBe(false);
    expect(s.state).toBe('starting');
    f.db.close();
  });

  it('holds the startup grace, then tells the truth', async () => {
    const f = fixture();
    let t = f.pane.created_at;
    const probe = createAppStatusProbe({
      db: f.db,
      ptyd: { hasPane: async () => true },
      probe: async () => GATEWAY,
      now: () => t,
      ttlMs: 0,
    });
    expect((await probe.status(f.app)).state).toBe('starting');
    t = f.pane.created_at + APP_STARTUP_GRACE_MS + 1;
    expect((await probe.status(f.app)).state).toBe('unreachable');
    f.db.close();
  });

  it('caches within the TTL and collapses a concurrent burst onto one probe', async () => {
    const f = fixture();
    let calls = 0;
    let t = 10_000_000;
    const probe = createAppStatusProbe({
      db: f.db,
      ptyd: { hasPane: async () => true },
      probe: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return OK;
      },
      now: () => t,
      ttlMs: 1000,
    });
    await Promise.all([probe.status(f.app), probe.status(f.app), probe.status(f.app)]);
    expect(calls).toBe(1);
    await probe.status(f.app);
    expect(calls).toBe(1);
    // Past the TTL it probes again…
    t += 2000;
    await probe.status(f.app);
    expect(calls).toBe(2);
    // …and an explicit invalidate (after a start/stop) forces a fresh read.
    probe.invalidate(f.app.id);
    await probe.status(f.app);
    expect(calls).toBe(3);
    f.db.close();
  });

  it('never throws out of a failing probe', async () => {
    const f = fixture();
    f.db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(1, f.pane.id);
    const probe = createAppStatusProbe({
      db: f.db,
      ptyd: { hasPane: async () => true },
      probe: async () => {
        throw new Error('boom');
      },
    });
    const s = await probe.status(f.app);
    expect(s.health).toBeNull();
    expect(s.state).toBe('starting');
    f.db.close();
  });
});
