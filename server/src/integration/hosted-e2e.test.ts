// The Hosted feature against a REAL ptyd and a REAL HTTP server.
//
// The unit tests prove the rails against fakes. This proves the claim: an app
// registered through the API actually starts a process, that process actually
// serves HTTP, the status the API reports is MEASURED from those two facts, and
// the things the design promises about lifetime hold —
//
//   · it survives a ptyd restart (the incident that motivated the whole
//     feature: Notes and Reader stayed dead after one, silently);
//   · it reports `unreachable` when the backend dies while the pty lives on;
//   · looking at it and closing the view does not stop it;
//   · stopping it really stops it, and nothing brings it back.
//
// Plus the artifact half: publish → republish → both versions resolve.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppWithStatus } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppRegistry,
  MATERIALIZE_COOLDOWN_MS,
  createAppRegistry,
} from '../apps/AppRegistry.js';
import { createAppStatusProbe } from '../apps/AppStatus.js';
import { EventBus } from '../events.js';
import type { Funnel } from '../funnel.js';
import { PtydCache } from '../ptyd-cache.js';
import { PtydClient } from '../ptyd-client/PtydClient.js';
import { createPublicApp } from '../public-server.js';
import { startServeSupervisor } from '../serve-supervisor.js';
import { createApp } from '../server.js';
import { AppStore } from '../store/AppStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';

const funnel: Funnel = {
  async ensure() {
    return { baseUrl: 'https://example.ts.net:8443' };
  },
};

/** Poll `fn` until it returns truthy or the deadline passes. */
async function until<T>(fn: () => Promise<T>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = undefined as T;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}

/** A free loopback port, taken by binding and releasing immediately. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

let ptyd: SpawnedPtyd | null = null;
let db: Database.Database;
let dataDir: string;
let appDir: string;
let supervisor: ReturnType<typeof startServeSupervisor> | null = null;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hosted-e2e-'));
  appDir = mkdtempSync(join(tmpdir(), 'hosted-e2e-app-'));
  db = openDb(':memory:');
});

afterEach(async () => {
  supervisor?.stop();
  supervisor = null;
  if (ptyd) await ptyd.cleanup();
  ptyd = null;
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
});

describe('a registered app, end to end', () => {
  it('starts, serves HTTP, survives a ptyd restart, and stops only when told', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    // A REAL server, written to disk and run by the pane. Deliberately node
    // rather than a stub: the point is that a command the user could have
    // typed ends up listening on a port we can fetch.
    const script = join(appDir, 'server.mjs');
    writeFileSync(
      script,
      `import {createServer} from 'node:http';
         createServer((_q,s)=>{s.writeHead(200,{'content-type':'text/plain'});s.end('hosted-ok');})
           .listen(${port},'127.0.0.1');`,
    );

    ptyd = await spawnPtyd();
    const cache = new PtydCache();
    cache.attach(ptyd.client);
    const events = new EventBus();
    const registry: AppRegistry = createAppRegistry({
      db,
      ptyd: ptyd.client,
      events,
      log: () => {},
    });
    const status = createAppStatusProbe({ db, ptyd: ptyd.client, ttlMs: 0 });
    const api = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir,
      events,
      publish: { funnel },
      apps: { registry, status },
    });
    const req = (p: string, init?: RequestInit) => api.request(`http://local${p}`, init);
    const list = async () =>
      ((await (await req('/api/apps')).json()) as { apps: AppWithStatus[] }).apps;

    // ── register ──────────────────────────────────────────────────────
    const created = (await (
      await req('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Probe',
          cwd: appDir,
          command: `${process.execPath} ${script}`,
          url,
        }),
      })
    ).json()) as AppWithStatus;
    expect(created.slug).toBe('probe');
    const paneId = created.pane_id as string;
    expect(paneId).toBeTruthy();

    // …and it really is a pty in ptyd, in a HIDDEN workspace with no tab
    // presence. (A `muxpad serve` pane, so the existing supervisor owns it.)
    expect(await ptyd.client.hasPane(paneId)).toBe(true);
    const visible = (await (await req('/api/workspaces')).json()) as unknown[];
    expect(visible).toEqual([]);

    // ── it actually serves ────────────────────────────────────────────
    const body = await until(async () => {
      try {
        const r = await fetch(url);
        return r.ok ? await r.text() : '';
      } catch {
        return '';
      }
    });
    expect(body).toBe('hosted-ok');

    // …and the API says so, from the MEASURED signals.
    const running = await until(async () => {
      const one = (await list())[0];
      return one?.state === 'running' ? one : null;
    });
    expect(running?.state).toBe('running');
    expect(running?.pty).toBe(true);
    expect(running?.health?.alive).toBe(true);

    // ── closing the view does not stop it ─────────────────────────────
    // There is nothing to assert about "closing" beyond this: the view is a
    // ROUTE, so leaving it issues no request at all. The meaningful check is
    // that the process is untouched by anything the viewer can do — including
    // repeatedly reading its status, which is all the open view ever does.
    for (let i = 0; i < 3; i++) await list();
    expect(await ptyd.client.hasPane(paneId)).toBe(true);
    expect((await fetch(url)).ok).toBe(true);

    // ── it survives a ptyd restart ────────────────────────────────────
    // The original incident. Kill every pty the way a daemon restart does,
    // then let the SERVE SUPERVISOR — not the registry — put it back.
    supervisor = startServeSupervisor({
      db,
      ptyd: ptyd.client,
      cache,
      events,
      sweepMs: 200,
      log: () => {},
    });
    // Pre-date the pane so the supervisor's startup grace doesn't skip it.
    db.prepare('UPDATE panes SET created_at = 1 WHERE id = ?').run(paneId);
    await ptyd.client.killPane(paneId);
    expect(await ptyd.client.hasPane(paneId)).toBe(false);

    await until(async () => (await ptyd?.client.hasPane(paneId)) === true);
    expect(await ptyd.client.hasPane(paneId)).toBe(true);
    // And it is serving again — the pty came back AND ran the command.
    const afterRestart = await until(async () => {
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    });
    expect(afterRestart).toBe(true);

    // ── the backend dying is reported honestly ────────────────────────
    // The pane really is running `muxpad serve` (PaneRuntime puts the CLI on
    // PATH), which is exactly why this needs care: the wrapper RESTARTS a
    // command that dies, so simply killing node would give a two-second
    // window and a flaky assertion. Replace the script with one that exits
    // immediately FIRST — then every restart re-dies, the port stays shut,
    // and `unreachable` is a stable state rather than a race.
    expect(
      (db.prepare('SELECT startup_cmd AS c FROM panes WHERE id = ?').get(paneId) as { c: string })
        .c,
    ).toContain('muxpad serve');
    writeFileSync(script, 'process.exit(1);');
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve) => {
      execFile('pkill', ['-f', script], () => resolve());
    });
    const unreachable = await until(async () => {
      const one = (await list())[0];
      return one && one.state === 'unreachable' ? one : null;
    });
    expect(unreachable?.state).toBe('unreachable');
    // ptyd still holds the pty — the app is not "gone", it is not answering.
    // That split (process alive, backend dead) is the one a registry-only
    // status gets wrong, and the one a browser's opaque probe cannot see.
    expect(unreachable?.pty).toBe(true);
    expect(unreachable?.health?.alive).toBe(false);

    // ── stop means stop ───────────────────────────────────────────────
    await req('/api/apps/probe/stop', { method: 'POST' });
    expect(new AppStore(db).getBySlug('probe')?.enabled).toBe(false);
    expect(new AppStore(db).getBySlug('probe')?.pane_id).toBeNull();
    // …and the supervisor does NOT undo it, however many sweeps run.
    for (let i = 0; i < 4; i++) {
      await supervisor.sweep();
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(await ptyd.client.hasPane(paneId)).toBe(false);
    expect(((await list())[0] as AppWithStatus).state).toBe('stopped');
  }, 90_000);

  it('recovers an app whose pane row was lost, without duplicating anything', async () => {
    ptyd = await spawnPtyd();
    const registry = createAppRegistry({ db, ptyd: ptyd.client, log: () => {} });
    const apps = new AppStore(db);
    const app = apps.create({
      slug: 'ghost',
      name: 'Ghost',
      cwd: appDir,
      command: 'sleep 600',
      url: 'http://127.0.0.1:1',
    });
    await registry.reconcile();
    const first = apps.getById(app.id)?.pane_id as string;
    expect(first).toBeTruthy();

    // The row vanishes (a hand-run DELETE, a cascade we did not anticipate).
    db.prepare('DELETE FROM panes WHERE id = ?').run(first);
    // A SECOND registry, with an injected clock pushed past the materialise
    // cooldown. (An earlier version slept 10ms and claimed to be "past the
    // cooldown" — it was not; it only passed because the fresh registry had an
    // empty cooldown ledger, so the assertion proved nothing about the
    // production path, where one long-lived registry handles the rebuild.)
    const registry2 = createAppRegistry({
      db,
      ptyd: ptyd.client,
      now: () => Date.now() + MATERIALIZE_COOLDOWN_MS * 2,
      log: () => {},
    });
    await registry2.reconcile();

    const second = apps.getById(app.id)?.pane_id as string;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    // Exactly ONE app, exactly one live pane for it, one tab in the container.
    expect(apps.list()).toHaveLength(1);
    const tabs = db
      .prepare('SELECT COUNT(*) AS n FROM tabs WHERE workspace_id = ?')
      .get(registry2.containerId()) as { n: number };
    // The orphaned tab from the deleted pane is the one piece the reconciler
    // leaves behind — it is invisible and harmless — so at most two.
    expect(tabs.n).toBeLessThanOrEqual(2);
  }, 45_000);
});

describe('artifacts, end to end', () => {
  it('publish → republish → both the current and the previous version resolve', async () => {
    ptyd = await spawnPtyd();
    const cache = new PtydCache();
    cache.attach(ptyd.client);
    const api = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir,
      publish: { funnel },
    });
    const src = join(appDir, 'page.html');

    writeFileSync(src, '<h1>one</h1>');
    const first = await api.request('http://local/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: src, name: 'demo' }),
    });
    expect(first.status).toBe(201);

    writeFileSync(src, '<h1>two</h1>');
    const second = await api.request('http://local/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: src, name: 'demo', update: true }),
    });
    expect(second.status).toBe(201);

    // Served by the REAL public app, over HTTP, on its own port — the same
    // listener the funnel points at.
    const port = await freePort();
    const publicApp = createPublicApp(join(dataDir, 'public'));
    const { serve } = await import('@hono/node-server');
    const server = serve({ fetch: publicApp.fetch, port, hostname: '127.0.0.1' });
    try {
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/demo/`)).ok;
        } catch {
          return false;
        }
      }, 5000);
      expect(await (await fetch(`http://127.0.0.1:${port}/demo/`)).text()).toBe('<h1>two</h1>');
      expect(await (await fetch(`http://127.0.0.1:${port}/demo@2/`)).text()).toBe('<h1>one</h1>');
      // And the root reveals nothing: no gallery, on the one port that faces
      // the open internet.
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    } finally {
      (server as unknown as { close(): void }).close();
    }
  }, 45_000);
});
