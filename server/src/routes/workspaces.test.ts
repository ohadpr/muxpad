import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('workspaces routes', () => {
  let test: TestApp;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-ws-'));
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    test.app.request(path, {
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

  it('uses a sequential default name when none is provided', async () => {
    const a = (await (await post('/api/workspaces', {})).json()) as { name: string };
    const b = (await (await post('/api/workspaces', {})).json()) as { name: string };
    const c2 = (await (await post('/api/workspaces', {})).json()) as { name: string };
    expect(a.name).toBe('Workspace 1');
    expect(b.name).toBe('Workspace 2');
    expect(c2.name).toBe('Workspace 3');
  });

  it('default name skips past existing Workspace N rather than reusing', async () => {
    // Mimic a real scenario: user renamed some, deleted some. The next
    // default should be max+1 across whatever's left, never colliding.
    await post('/api/workspaces', { name: 'Workspace 5' });
    await post('/api/workspaces', { name: 'My project' });
    const next = (await (await post('/api/workspaces', {})).json()) as { name: string };
    expect(next.name).toBe('Workspace 6');
  });

  it('lists workspaces', async () => {
    await post('/api/workspaces', { name: 'A' });
    await post('/api/workspaces', { name: 'B' });
    const res = await test.app.request('/api/workspaces');
    const list = (await res.json()) as Array<{ name: string; tab_count: number }>;
    expect(list.map((w) => w.name).sort()).toEqual(['A', 'B']);
    expect(list.every((w) => w.tab_count === 0)).toBe(true);
  });

  it('returns 404 for missing workspace', async () => {
    const res = await test.app.request('/api/workspaces/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('renames a workspace', async () => {
    const w = (await (await post('/api/workspaces', { name: 'A' })).json()) as {
      id: string;
    };
    const res = await test.app.request(`/api/workspaces/${w.id}`, {
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
    const res = await test.app.request(`/api/workspaces/${w.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('cascades tab + pane deletion when deleting a non-empty workspace', async () => {
    const w = (await (await post('/api/workspaces', { name: 'A' })).json()) as {
      id: string;
    };
    const t = (await (await post('/api/tabs', { workspace_id: w.id, name: 'T' })).json()) as {
      id: string;
    };
    // Workspace delete should succeed (204) and the tab should be gone.
    const res = await test.app.request(`/api/workspaces/${w.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const tabAfter = await test.app.request(`/api/tabs/${t.id}`);
    expect(tabAfter.status).toBe(404);
  });

  it('workspace POST/PATCH/DELETE all emit on the event bus', async () => {
    const events = new EventBus();
    const local = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, events });
    try {
      const received: MuxpadEvent[] = [];
      events.subscribe((e) => received.push(e));

      const created = (await (
        await local.app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Alpha' }),
        })
      ).json()) as { id: string };
      await local.app.request(`/api/workspaces/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Beta' }),
      });
      await local.app.request(`/api/workspaces/${created.id}`, { method: 'DELETE' });

      expect(received.find((e) => e.type === 'workspace.added')).toBeDefined();
      expect(received.find((e) => e.type === 'workspace.updated')).toBeDefined();
      const removed = received.find((e) => e.type === 'workspace.removed');
      expect(removed).toBeDefined();
      if (removed?.type === 'workspace.removed') {
        expect(removed.workspace_id).toBe(created.id);
      }
    } finally {
      await local.cleanup();
    }
  });

  it('a COLLAPSED workspace still reports status + agents (D2)', async () => {
    // The per-tab spinners live in TabList, which mounts only while the
    // workspace is expanded — and the default expansion is
    // active-workspace-only. So on a fresh profile every agent working in a
    // collapsed workspace was invisible, and that workspace's poll was
    // stopped too. The workspace ROW now carries the rollup, computed
    // server-side on every list call, so it needs nothing mounted.
    const ws = (await (await post('/api/workspaces', { name: 'W' })).json()) as { id: string };
    const tab = (await (await post('/api/tabs', { name: 'T', workspace_id: ws.id })).json()) as {
      id: string;
    };
    const pane = (await (
      await post(`/api/tabs/${tab.id}/panes`, { startup_cmd: 'muxpad agent', face: 'chat' })
    ).json()) as { id: string };

    const list = async () =>
      (
        (await (await test.app.request('/api/workspaces')).json()) as Array<{
          id: string;
          status?: string;
          agents?: number;
        }>
      ).find((w) => w.id === ws.id);

    expect(await list()).toMatchObject({ status: 'idle', agents: 0 });

    // A turn starts in a pane nobody is looking at.
    test.cache.setAgentBusy(pane.id, true);
    expect(await list()).toMatchObject({ status: 'working' });

    // …and a background subagent keeps it working past turn-done, with a count.
    test.cache.setAgentBusy(pane.id, false);
    test.cache.setSubagentCount(pane.id, 3);
    expect(await list()).toMatchObject({ status: 'working', agents: 3 });

    // A question outranks working.
    test.cache.setBlocked(pane.id, true);
    expect(await list()).toMatchObject({ status: 'blocked' });

    // Everything quiet → idle again (no unread on this pane).
    test.cache.setBlocked(pane.id, false);
    test.cache.setSubagentCount(pane.id, 0);
    expect(await list()).toMatchObject({ status: 'idle', agents: 0 });

    // A dead runner is not the same as a quiet one.
    test.cache.setDead(pane.id, true);
    expect(await list()).toMatchObject({ status: 'dead' });
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
    const res = await test.app.request('/api/workspaces/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [c.id, a.id, b.id] }),
    });
    expect(res.status).toBe(204);
    const list = (await (await test.app.request('/api/workspaces')).json()) as Array<{
      id: string;
    }>;
    expect(list.map((w) => w.id)).toEqual([c.id, a.id, b.id]);
  });
});
