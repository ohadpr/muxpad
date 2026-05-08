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
    const res = await post('/api/workspaces', { name: 'Dev' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBeTruthy();
    // Slugs are now random short IDs, not name-derived.
    expect(body.slug).toMatch(/^[A-Za-z2-9]{8}$/);
  });

  it('lists workspaces', async () => {
    await post('/api/workspaces', { name: 'A' });
    await post('/api/workspaces', { name: 'B' });
    const res = await app.request('/api/workspaces');
    const list = (await res.json()) as Array<{ name: string }>;
    expect(list.map((w) => w.name).sort()).toEqual(['A', 'B']);
  });

  it('gets a workspace including its panes', async () => {
    const w = (await (await post('/api/workspaces', { name: 'Dev' })).json()) as {
      id: string;
    };
    await post(`/api/workspaces/${w.id}/panes`, {});
    const res = await app.request(`/api/workspaces/${w.id}`);
    const body = (await res.json()) as { panes: unknown[] };
    expect(body.panes).toHaveLength(1);
  });

  it('updates a workspace layout', async () => {
    const created = (await (await post('/api/workspaces', { name: 'Dev' })).json()) as {
      id: string;
    };
    const res = await app.request(`/api/workspaces/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: { direction: 'row', first: 'a', second: 'b' },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('deletes a workspace', async () => {
    const created = (await (await post('/api/workspaces', { name: 'Dev' })).json()) as {
      id: string;
    };
    const res = await app.request(`/api/workspaces/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 for missing workspace', async () => {
    const res = await app.request('/api/workspaces/does-not-exist');
    expect(res.status).toBe(404);
  });
});
