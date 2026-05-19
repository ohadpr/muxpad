import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../store/db.js';
import { EventBus } from '../events.js';
import type { MuxpadEvent } from '@muxpad/shared';
import { createTestApp, type TestApp } from '../test-helpers/createTestApp.js';

describe('tabs routes', () => {
  let test: TestApp;
  let tmp: string;
  let workspaceId: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-tabs-'));
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp });
    // Every tab needs a parent workspace. Spin one up fresh for each test.
    const wsRes = await test.app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    const ws = (await wsRes.json()) as { id: string };
    workspaceId = ws.id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const postTab = (body: object) =>
    test.app.request('/api/tabs', {
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
    const res = await test.app.request(`/api/tabs?workspaceId=${workspaceId}`);
    const list = (await res.json()) as Array<{ name: string }>;
    expect(list.map((t) => t.name).sort()).toEqual(['A', 'B']);
  });

  it('400s when listing without workspaceId', async () => {
    const res = await test.app.request('/api/tabs');
    expect(res.status).toBe(400);
  });

  it('gets a tab including its panes', async () => {
    const t = (await (await postTab({ name: 'Dev' })).json()) as { id: string };
    await test.app.request(`/api/tabs/${t.id}/panes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await test.app.request(`/api/tabs/${t.id}`);
    const body = (await res.json()) as { panes: unknown[] };
    expect(body.panes).toHaveLength(1);
  });

  it('updates a tab layout', async () => {
    const created = (await (await postTab({ name: 'Dev' })).json()) as { id: string };
    const res = await test.app.request(`/api/tabs/${created.id}`, {
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
    const res = await test.app.request(`/api/tabs/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 for missing tab', async () => {
    const res = await test.app.request('/api/tabs/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST/PATCH/DELETE /tabs emit tab.added, tab.updated, tab.removed', async () => {
    // Single combined test exercises the full tab CRUD → bus path so the
    // route layer can't silently drop one of the three verbs.
    const events = new EventBus();
    const local = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, events });
    try {
      const ws = (await (
        await local.app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'W' }),
        })
      ).json()) as { id: string };

      const received: MuxpadEvent[] = [];
      events.subscribe((e) => received.push(e));

      const created = (await (
        await local.app.request('/api/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'T', workspace_id: ws.id }),
        })
      ).json()) as { id: string };
      await local.app.request(`/api/tabs/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'T2' }),
      });
      await local.app.request(`/api/tabs/${created.id}`, { method: 'DELETE' });

      const added = received.find((e) => e.type === 'tab.added');
      const updated = received.find((e) => e.type === 'tab.updated');
      const removed = received.find((e) => e.type === 'tab.removed');
      expect(added).toBeDefined();
      expect(updated).toBeDefined();
      expect(removed).toBeDefined();
      if (added?.type === 'tab.added') {
        expect(added.workspace_id).toBe(ws.id);
        expect(added.tab.id).toBe(created.id);
      }
      if (removed?.type === 'tab.removed') {
        expect(removed.workspace_id).toBe(ws.id);
        expect(removed.tab_id).toBe(created.id);
      }
    } finally {
      await local.cleanup();
    }
  });
});
