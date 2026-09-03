// GET /api/tabs/all — the one read behind the sidebar's search box.
//
// The contract that matters is not "it returns tabs": it is that it returns
// the SAME rows, decorated the same way and in the same order, as the
// per-workspace list the tree renders — because a result row and the tree row
// it navigates to are the same thing seen twice — and that it never leaks the
// hidden system container the navigator cannot reach.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

interface AllTabsBody {
  workspaces: Array<{ id: string; slug: string; name: string; tabs: Tab[] }>;
}

describe('GET /api/tabs/all — the cross-workspace search corpus', () => {
  let test: TestApp;
  let db: Database.Database;
  let tmp: string;

  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-tabs-all-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function makeWorkspace(name: string): Promise<{ id: string; slug: string }> {
    return (await (
      await test.app.request('/api/workspaces', { method: 'POST', ...json({ name }) })
    ).json()) as { id: string; slug: string };
  }
  async function makeTab(workspaceId: string, name: string): Promise<Tab> {
    return (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: workspaceId, name }),
      })
    ).json()) as Tab;
  }
  const all = async (): Promise<AllTabsBody> =>
    (await (await test.app.request('/api/tabs/all')).json()) as AllTabsBody;

  it('answers an empty group list when there is nothing at all', async () => {
    expect(await all()).toEqual({ workspaces: [] });
  });

  it('groups every visible workspace with its name and slug', async () => {
    const a = await makeWorkspace('Alpha');
    const b = await makeWorkspace('Beta');
    await makeTab(a.id, 'one');
    await makeTab(b.id, 'two');
    const body = await all();
    expect(body.workspaces.map((w) => w.name)).toEqual(['Alpha', 'Beta']);
    // The slug is half the route a search result navigates to, which is the
    // whole reason the payload is grouped rather than a flat tab list.
    expect(body.workspaces[0]?.slug).toBe(a.slug);
    expect(body.workspaces.map((w) => w.tabs.map((t) => t.name))).toEqual([['one'], ['two']]);
  });

  it('lists a workspace with no tabs rather than dropping it', async () => {
    await makeWorkspace('Empty');
    const body = await all();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]?.tabs).toEqual([]);
  });

  it('excludes the hidden system container — the navigator cannot reach it', async () => {
    const visible = await makeWorkspace('Visible');
    await makeTab(visible.id, 'reachable');
    const hidden = new WorkspaceStore(db).createHidden({ name: 'apps' });
    await makeTab(hidden.id, 'unreachable');
    const body = await all();
    expect(body.workspaces.map((w) => w.name)).toEqual(['Visible']);
    const names = body.workspaces.flatMap((w) => w.tabs.map((t) => t.name));
    expect(names).not.toContain('unreachable');
  });

  it('decorates rows exactly like the per-workspace list, in the same order', async () => {
    const ws = await makeWorkspace('W');
    const a = await makeTab(ws.id, 'A');
    const b = await makeTab(ws.id, 'B');
    const c = await makeTab(ws.id, 'C');
    db.prepare('UPDATE tabs SET last_activity_at = ? WHERE id = ?').run(1, a.id);
    db.prepare('UPDATE tabs SET last_activity_at = ? WHERE id = ?').run(9999, b.id);
    db.prepare('UPDATE tabs SET last_activity_at = ? WHERE id = ?').run(500, c.id);
    await test.app.request(`/api/tabs/${c.id}`, { method: 'PATCH', ...json({ pinned: true }) });

    const perWorkspace = (await (
      await test.app.request(`/api/tabs?workspaceId=${ws.id}`)
    ).json()) as Tab[];
    const grouped = (await all()).workspaces[0]?.tabs ?? [];
    // Byte-identical, not merely "same set": the search list and the tree are
    // two renderings of one server-owned order, and a disagreement between
    // them is a result row that jumps when you land on it.
    expect(grouped).toEqual(perWorkspace);
    expect(grouped.map((t) => t.name)).toEqual(['C', 'B', 'A']);
  });

  it('carries the fields the search matches on: headline, status, pinned, activity', async () => {
    const ws = await makeWorkspace('W');
    const t = await makeTab(ws.id, 'Investing');
    db.prepare('UPDATE tabs SET headline = ? WHERE id = ?').run('portfolio rebalancing', t.id);
    const paneId = (
      (await (
        await test.app.request(`/api/tabs/${t.id}/panes`, {
          method: 'POST',
          ...json({ append_to_layout: true }),
        })
      ).json()) as { id: string }
    ).id;
    test.cache.setAgentBusy(paneId, true);

    const row = (await all()).workspaces[0]?.tabs[0];
    expect(row).toMatchObject({
      name: 'Investing',
      headline: 'portfolio rebalancing',
      status: 'working',
      pinned: false,
    });
    expect(typeof row?.last_activity_at).toBe('number');
    // The layout is what maps a message hit's pane back to its tab client-side.
    expect(JSON.stringify(row?.layout)).toContain(paneId);
  });

  it('does not collide with GET /api/tabs/:id', async () => {
    const ws = await makeWorkspace('W');
    const t = await makeTab(ws.id, 'A');
    const byId = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as Tab;
    expect(byId.id).toBe(t.id);
    // And the unknown-id path still 404s rather than being shadowed.
    expect((await test.app.request('/api/tabs/nope')).status).toBe(404);
  });

  it('still requires workspaceId on the per-workspace list', async () => {
    // `?all=1` is deliberately NOT a mode of the old route: the two answer
    // different SHAPES, and one endpoint returning an array or an object
    // depending on a query param is how a client ends up parsing both.
    expect((await test.app.request('/api/tabs')).status).toBe(400);
  });
});
