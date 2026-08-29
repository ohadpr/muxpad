import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CEO_WORKSPACE_NAME, ceoHomeDir, ensureCeoPane, ensureCeoRuntime } from '../ceo.js';
import { EventBus } from '../events.js';
import { PtydClient } from '../ptyd-client/PtydClient.js';
import { startPtyd } from '../ptyd/index.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

interface CeoIds {
  pane_id: string;
  tab_id: string;
  workspace_slug: string;
  tab_slug: string;
}

describe('/api/ceo + CEO guards', () => {
  let test: TestApp;
  let tmp: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-ceo-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const getCeo = async (): Promise<CeoIds> => {
    const res = await test.app.request('/api/ceo');
    expect(res.status).toBe(200);
    return (await res.json()) as CeoIds;
  };

  it('ensures the hidden workspace → ceo tab → agent pane and returns ids', async () => {
    const ids = await getCeo();
    expect(ids.pane_id).toBeTruthy();
    expect(ids.tab_id).toBeTruthy();
    expect(ids.workspace_slug).toBeTruthy();
    expect(ids.tab_slug).toBeTruthy();

    // The pane is a regular agent pane: chat face, `muxpad agent`,
    // MUXPAD_ROLE=ceo, homed in <dataDir>/ceo.
    const paneRes = await test.app.request(`/api/panes/${ids.pane_id}`);
    expect(paneRes.status).toBe(200);
    const pane = (await paneRes.json()) as {
      tab_id: string;
      face: string;
      startup_cmd: string;
      cwd: string;
      env: Record<string, string> | null;
    };
    expect(pane.tab_id).toBe(ids.tab_id);
    expect(pane.face).toBe('chat');
    expect(pane.startup_cmd).toBe('muxpad agent');
    expect(pane.cwd).toBe(ceoHomeDir(tmp));
    expect(pane.env).toEqual({ MUXPAD_ROLE: 'ceo' });

    // Its tab lives in the hidden system workspace, wired into the layout.
    const tabRes = await test.app.request(`/api/tabs/${ids.tab_id}`);
    expect(tabRes.status).toBe(200);
    const tab = (await tabRes.json()) as { name: string; slug: string; layout: unknown };
    expect(tab.name).toBe('ceo');
    expect(tab.layout).toBe(ids.pane_id);
    // The returned slugs match the actual rows, so the web app can route the
    // CEO through the normal /w/:ws/t/:tab surface.
    expect(ids.tab_slug).toBe(tab.slug);
    const all = (await (await test.app.request('/api/workspaces?all=1')).json()) as Array<{
      slug: string;
      hidden?: boolean;
    }>;
    const sys = all.find((w) => w.hidden);
    expect(sys?.slug).toBe(ids.workspace_slug);
  });

  it('is idempotent — repeated calls return the same ids', async () => {
    const a = await getCeo();
    const b = await getCeo();
    expect(b).toEqual(a);
    // Exactly one hidden system workspace exists.
    const all = (await (await test.app.request('/api/workspaces?all=1')).json()) as Array<{
      name: string;
      hidden?: boolean;
    }>;
    expect(all.filter((w) => w.hidden)).toHaveLength(1);
  });

  it('is stable across a server restart (same db, fresh app)', async () => {
    const a = await getCeo();
    const second = await createTestApp({ db, dataDir: tmp });
    try {
      const res = await second.app.request('/api/ceo');
      expect(res.status).toBe(200);
      expect((await res.json()) as CeoIds).toEqual(a);
    } finally {
      await second.cleanup();
    }
  });

  it('hides the system workspace from GET /api/workspaces unless ?all=1', async () => {
    await getCeo();
    const visible = (await (await test.app.request('/api/workspaces')).json()) as Array<{
      name: string;
    }>;
    expect(visible.some((w) => w.name === CEO_WORKSPACE_NAME)).toBe(false);
    const all = (await (await test.app.request('/api/workspaces?all=1')).json()) as Array<{
      name: string;
      hidden?: boolean;
    }>;
    const sys = all.find((w) => w.name === CEO_WORKSPACE_NAME);
    expect(sys).toBeTruthy();
    expect(sys?.hidden).toBe(true);
  });

  it('refuses to delete the CEO pane, its tab, or its workspace (409)', async () => {
    const ids = await getCeo();
    const paneDel = await test.app.request(`/api/panes/${ids.pane_id}`, { method: 'DELETE' });
    expect(paneDel.status).toBe(409);
    const tabDel = await test.app.request(`/api/tabs/${ids.tab_id}`, { method: 'DELETE' });
    expect(tabDel.status).toBe(409);
    const all = (await (await test.app.request('/api/workspaces?all=1')).json()) as Array<{
      id: string;
      hidden?: boolean;
    }>;
    const sys = all.find((w) => w.hidden);
    expect(sys).toBeTruthy();
    const wsDel = await test.app.request(`/api/workspaces/${sys?.id}`, { method: 'DELETE' });
    expect(wsDel.status).toBe(409);
    // Everything still resolves.
    expect(await getCeo()).toEqual(ids);
  });

  it('still deletes ordinary panes/tabs/workspaces', async () => {
    await getCeo();
    const w = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'normal' }),
      })
    ).json()) as { id: string };
    const del = await test.app.request(`/api/workspaces/${w.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  it('seeds the playbook once and never overwrites a user-owned copy', async () => {
    const ids = await getCeo();
    const playbook = join(ceoHomeDir(tmp), 'CLAUDE.md');
    expect(existsSync(playbook)).toBe(true);
    expect(readFileSync(playbook, 'utf-8')).toContain('muxpad pane list --all');

    // The user edits the playbook, then the CEO is torn down out-of-band
    // (simulated torn state: pane row + pointers gone). Re-ensure must
    // rebuild the pane but leave the edited playbook alone.
    writeFileSync(playbook, '# mine now\n');
    db.prepare('DELETE FROM panes WHERE id = ?').run(ids.pane_id);
    db.prepare("DELETE FROM globals WHERE key IN ('ceo_pane_id', 'ceo_tab_id')").run();

    const rebuilt = await getCeo();
    expect(rebuilt.pane_id).not.toBe(ids.pane_id);
    expect(readFileSync(playbook, 'utf-8')).toBe('# mine now\n');
    // Recovery reuses the existing hidden workspace — no duplicates accrete.
    const all = (await (await test.app.request('/api/workspaces?all=1')).json()) as Array<{
      hidden?: boolean;
    }>;
    expect(all.filter((w) => w.hidden)).toHaveLength(1);
  });
});

describe('CEO cold-boot ptyd race', () => {
  it('spawns the CEO pty on ptyd connect when boot beat ptyd to its socket', async () => {
    // Cold boot: the server (and its ensureCeoPane) starts BEFORE ptyd is
    // listening — the eager spawn fails with 'ptyd disconnected'. The
    // 'connected' hook (wired exactly as index.ts does) must bring the CEO
    // alive within seconds of ptyd appearing, not wait on the ~50s sweep.
    const dir = mkdtempSync(join(tmpdir(), 'muxpad-ceo-cold-'));
    const socketPath = join(dir, 'ptyd.sock');
    const coldDb = openDb(':memory:');
    const client = new PtydClient({ socketPath, initialBackoffMs: 50, maxBackoffMs: 200 });
    client.on('connected', () => {
      void ensureCeoRuntime({ db: coldDb, ptyd: client });
    });
    try {
      const ids = await ensureCeoPane({
        db: coldDb,
        ptyd: client,
        events: new EventBus(),
        dataDir: dir,
      });
      expect(client.connected).toBe(false); // rows committed, spawn failed

      const handle = await startPtyd({ socketPath, cwdPollInterval: 50, cmdPollInterval: 50 });
      try {
        const deadline = Date.now() + 5000;
        let alive = false;
        while (Date.now() < deadline && !alive) {
          try {
            alive = await client.hasPane(ids.pane_id);
          } catch {
            // not reconnected yet
          }
          if (!alive) await new Promise((r) => setTimeout(r, 100));
        }
        expect(alive).toBe(true);
      } finally {
        await handle.stop();
      }
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
