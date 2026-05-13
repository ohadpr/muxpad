import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { openDb } from '../store/db.js';
import { PaneManager } from '../runtime/PaneManager.js';

describe('tabs routes', () => {
  let app: ReturnType<typeof createApp>;
  let tmp: string;
  let mgr: PaneManager;
  let workspaceId: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-tabs-'));
    mgr = new PaneManager();
    app = createApp({ db: openDb(':memory:'), paneManager: mgr, dataDir: tmp });
    // Every tab needs a parent workspace. Spin one up fresh for each test.
    const wsRes = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    const ws = (await wsRes.json()) as { id: string };
    workspaceId = ws.id;
  });

  afterEach(async () => {
    await mgr.killAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  const postTab = (body: object) =>
    app.request('/api/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, ...body }),
    });

  it('creates a tab', async () => {
    const res = await postTab({ name: 'Dev' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBeTruthy();
    expect(body.slug).toMatch(/^[A-Za-z2-9]{8}$/);
  });

  it('lists tabs scoped to a workspace', async () => {
    await postTab({ name: 'A' });
    await postTab({ name: 'B' });
    const res = await app.request(`/api/tabs?workspaceId=${workspaceId}`);
    const list = (await res.json()) as Array<{ name: string }>;
    expect(list.map((t) => t.name).sort()).toEqual(['A', 'B']);
  });

  it('400s when listing without workspaceId', async () => {
    const res = await app.request('/api/tabs');
    expect(res.status).toBe(400);
  });

  it('gets a tab including its panes', async () => {
    const t = (await (await postTab({ name: 'Dev' })).json()) as { id: string };
    await app.request(`/api/tabs/${t.id}/panes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await app.request(`/api/tabs/${t.id}`);
    const body = (await res.json()) as { panes: unknown[] };
    expect(body.panes).toHaveLength(1);
  });

  it('updates a tab layout', async () => {
    const created = (await (await postTab({ name: 'Dev' })).json()) as { id: string };
    const res = await app.request(`/api/tabs/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: { direction: 'row', first: 'a', second: 'b' },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('deletes a tab', async () => {
    const created = (await (await postTab({ name: 'Dev' })).json()) as { id: string };
    const res = await app.request(`/api/tabs/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 for missing tab', async () => {
    const res = await app.request('/api/tabs/does-not-exist');
    expect(res.status).toBe(404);
  });
});
