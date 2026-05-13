import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { openDb } from '../store/db.js';
import { PaneManager } from '../runtime/PaneManager.js';

describe('workspaces routes', () => {
  let app: ReturnType<typeof createApp>;
  let tmp: string;
  let mgr: PaneManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-ws-'));
    mgr = new PaneManager();
    app = createApp({ db: openDb(':memory:'), paneManager: mgr, dataDir: tmp });
  });

  afterEach(async () => {
    await mgr.killAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates a workspace', async () => {
    const res = await post('/api/workspaces', { name: 'Project Alpha' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; tab_count: number };
    expect(body.id).toBeTruthy();
    expect(body.tab_count).toBe(0);
  });

  it('uses a generated name when none is provided', async () => {
    const res = await post('/api/workspaces', {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    expect(body.name.length).toBeGreaterThan(0);
  });

  it('lists workspaces', async () => {
    await post('/api/workspaces', { name: 'A' });
    await post('/api/workspaces', { name: 'B' });
    const res = await app.request('/api/workspaces');
    const list = (await res.json()) as Array<{ name: string; tab_count: number }>;
    expect(list.map((w) => w.name).sort()).toEqual(['A', 'B']);
    expect(list.every((w) => w.tab_count === 0)).toBe(true);
  });

  it('returns 404 for missing workspace', async () => {
    const res = await app.request('/api/workspaces/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('renames a workspace', async () => {
    const w = (await (await post('/api/workspaces', { name: 'A' })).json()) as {
      id: string;
    };
    const res = await app.request(`/api/workspaces/${w.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A renamed' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('A renamed');
  });

  it('deletes an empty workspace', async () => {
    const w = (await (await post('/api/workspaces', { name: 'A' })).json()) as {
      id: string;
    };
    const res = await app.request(`/api/workspaces/${w.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('refuses to delete a workspace with tabs (409)', async () => {
    const w = (await (await post('/api/workspaces', { name: 'A' })).json()) as {
      id: string;
    };
    await post('/api/tabs', { workspace_id: w.id, name: 'T' });
    const res = await app.request(`/api/workspaces/${w.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('workspace_not_empty');
  });

  it('reorders workspaces', async () => {
    const a = (await (await post('/api/workspaces', { name: 'A' })).json()) as {
      id: string;
    };
    const b = (await (await post('/api/workspaces', { name: 'B' })).json()) as {
      id: string;
    };
    const c = (await (await post('/api/workspaces', { name: 'C' })).json()) as {
      id: string;
    };
    const res = await app.request('/api/workspaces/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [c.id, a.id, b.id] }),
    });
    expect(res.status).toBe(204);
    const list = (await (await app.request('/api/workspaces')).json()) as Array<{
      id: string;
    }>;
    expect(list.map((w) => w.id)).toEqual([c.id, a.id, b.id]);
  });
});
