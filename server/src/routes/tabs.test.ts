import type { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { TabStore } from '../store/TabStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('tabs routes', () => {
  let test: TestApp;
  let tmp: string;
  let workspaceId: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-tabs-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
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

  it('GET /tabs/:id decorates each pane with its current attention flag', async () => {
    // Locks in the route → cache wiring for per-pane attention. We forge
    // a paneAttention event onto the underlying PtydClient (mirroring
    // ptyd's normal push path; see ptyd-cache.test.ts) and confirm the
    // GET endpoint surfaces the flag on the matching pane row.
    const t = (await (await postTab({ name: 'A' })).json()) as { id: string };
    const p1 = (await (
      await test.app.request(`/api/tabs/${t.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const p2 = (await (
      await test.app.request(`/api/tabs/${t.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    (test.ptyd.client as unknown as EventEmitter).emit('paneAttention', {
      id: p1.id,
      attention: true,
    });

    const detail = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as {
      panes: Array<{ id: string; attention?: boolean }>;
    };
    const got1 = detail.panes.find((p) => p.id === p1.id);
    const got2 = detail.panes.find((p) => p.id === p2.id);
    expect(got1?.attention).toBe(true);
    expect(got2?.attention).toBe(false);
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

  it('persists view_mode via PATCH and rejects junk values', async () => {
    const created = (await (await postTab({ name: 'Dev' })).json()) as {
      id: string;
      view_mode?: string;
    };
    expect(created.view_mode).toBe('tabbed'); // tabbed-first default for new tabs
    const res = await test.app.request(`/api/tabs/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ view_mode: 'split' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { view_mode?: string }).view_mode).toBe('split');
    const got = (await (await test.app.request(`/api/tabs/${created.id}`)).json()) as {
      view_mode?: string;
    };
    expect(got.view_mode).toBe('split');
    // zod enum: anything but split|tabbed is rejected — an error status, no write.
    const bad = await test.app.request(`/api/tabs/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ view_mode: 'mosaic' }),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('a PATCH that fails mid-way rolls the pin back, and 400s a junk body', async () => {
    // `{pinned:true, slug:'<taken>'}` used to persist the pin AND the position
    // change, then report 404 from a bare catch around tabs.update — a caller
    // told "no such tab" about a tab that had just been half-edited.
    const a = (await (await postTab({ name: 'A' })).json()) as { id: string; slug: string };
    const b = (await (await postTab({ name: 'B' })).json()) as { id: string; pinned?: boolean };
    const res = await test.app.request(`/api/tabs/${b.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true, slug: a.slug }),
    });
    expect(res.status).toBe(409); // not the old misleading 404
    const after = (await (await test.app.request(`/api/tabs/${b.id}`)).json()) as {
      pinned?: boolean;
      slug: string;
    };
    expect(after.pinned).toBeFalsy();
    expect(after.slug).not.toBe(a.slug);

    // A malformed body is the caller's fault: 400, not a 500 from an uncaught
    // ZodError (the handler used to call `.parse`).
    const junk = await test.app.request(`/api/tabs/${b.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: 'yes-please' }),
    });
    expect(junk.status).toBe(400);
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

  // ── tab → workspace move (POST /api/tabs/:id/move) ────────────────────

  const mkWorkspace = async (name: string): Promise<string> =>
    (
      (await (
        await test.app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).json()) as { id: string }
    ).id;

  it('moves a tab to another workspace', async () => {
    const tab = (await (await postTab({ name: 'Mover' })).json()) as { id: string };
    const dest = await mkWorkspace('Dest');
    const res = await test.app.request(`/api/tabs/${tab.id}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: dest }),
    });
    expect(res.status).toBe(200);
    // Gone from the source workspace, present in the destination.
    const srcList = (await (
      await test.app.request(`/api/tabs?workspaceId=${workspaceId}`)
    ).json()) as { id: string }[];
    const destList = (await (await test.app.request(`/api/tabs?workspaceId=${dest}`)).json()) as {
      id: string;
    }[];
    expect(srcList.some((t) => t.id === tab.id)).toBe(false);
    expect(destList.some((t) => t.id === tab.id)).toBe(true);
  });

  it('rejects a move to a non-existent workspace (FK)', async () => {
    const tab = (await (await postTab({ name: 'X' })).json()) as { id: string };
    const res = await test.app.request(`/api/tabs/${tab.id}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'does-not-exist' }),
    });
    expect(res.status).toBe(400);
  });

  it('tab→workspace move emits tab.removed (old) + tab.added (new)', async () => {
    const events = new EventBus();
    const local = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, events });
    try {
      const mkWs = async (name: string) =>
        (
          (await (
            await local.app.request('/api/workspaces', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            })
          ).json()) as { id: string }
        ).id;
      const from = await mkWs('From');
      const to = await mkWs('To');
      const tab = (await (
        await local.app.request('/api/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'T', workspace_id: from }),
        })
      ).json()) as { id: string };

      const received: MuxpadEvent[] = [];
      events.subscribe((e) => received.push(e));
      await local.app.request(`/api/tabs/${tab.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: to }),
      });

      const removed = received.find((e) => e.type === 'tab.removed');
      const added = received.find((e) => e.type === 'tab.added');
      expect(removed?.type === 'tab.removed' && removed.workspace_id).toBe(from);
      expect(added?.type === 'tab.added' && added.workspace_id).toBe(to);
    } finally {
      await local.cleanup();
    }
  });
  it('PATCHing an icon marks it sticky, permanently and one-way', async () => {
    // The generator's hard stop. Setting an icon by hand through the picker is
    // the ONLY way a human puts a glyph on a row, and this route is where it
    // lands — so this is the only place the flag has to be set, and the only
    // place it can be missed. Asserted through the HTTP surface rather than on
    // the store, because a store method nobody calls would satisfy a unit test
    // and still leave the picker writing an icon the model then overwrote.
    const created = await postTab({ name: 'A' });
    const tab = (await created.json()) as { id: string };
    const tabs = new TabStore(db);
    expect(tabs.isIconSticky(tab.id)).toBe(false);

    const patch = (body: object) =>
      test.app.request(`/api/tabs/${tab.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await patch({ icon: '🚀' })).status).toBe(200);
    expect(tabs.isIconSticky(tab.id)).toBe(true);
    expect(tabs.getById(tab.id)?.icon).toBe('🚀');

    // One-way: nothing later un-sticks it. Re-picking, renaming, pinning —
    // none of them hands the glyph back to the machine.
    await patch({ icon: '🐛' });
    await patch({ name: 'renamed' });
    await patch({ pinned: true });
    expect(tabs.isIconSticky(tab.id)).toBe(true);
    expect(tabs.getById(tab.id)?.icon).toBe('🐛');
  });

  it('a PATCH that does not mention the icon leaves it un-sticky', async () => {
    // Otherwise every rename, pin and layout change would quietly freeze the
    // glyph, and the generator would never write one on any tab the user had
    // ever touched.
    const created = await postTab({ name: 'A' });
    const tab = (await created.json()) as { id: string };
    await test.app.request(`/api/tabs/${tab.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'B', pinned: true }),
    });
    expect(new TabStore(db).isIconSticky(tab.id)).toBe(false);
  });

  it('a new tab is born with NO icon, so the generator may give it one', async () => {
    // Tabs used to get a random emoji here. That was not merely meaningless —
    // a non-null icon is the generator's own hands-off signal, so the random
    // default silently disabled content-derived icons for every tab ever made.
    const created = await postTab({ name: 'A' });
    const tab = (await created.json()) as { id: string; icon?: string };
    expect(tab.icon).toBeUndefined();
    expect(new TabStore(db).getById(tab.id)?.icon).toBeUndefined();
  });
});
