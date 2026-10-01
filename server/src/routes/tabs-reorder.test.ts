// POST /api/tabs/reorder — the drag nobody else used to see.
//
// This route wrote to the database and said nothing. The excuse in the code
// was that the sidebar poll would cover it, and that was wrong twice over:
//
//   · the poll is stopped for a hidden document and for a collapsed
//     workspace, which is the state of roughly every second open device; and
//   · this is not merely a sort TIEBREAK. The pinned block is ordered purely
//     by `position` — `orderedForWorkspace` partitions a position-sorted read
//     and `sortSidebarTabs` leaves that slice alone — so a drag inside it has
//     a fully visible result that nothing else on the bus implies.
//
// So the contract under test is: a successful reorder emits exactly one
// coarse `tabs.reordered` naming the workspace, and the ids it was given are
// the only thing it reads the workspace from.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent, Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('POST /api/tabs/reorder announces itself', () => {
  let test: TestApp;
  let db: Database.Database;
  let tmp: string;
  let events: EventBus;
  let seen: MuxpadEvent[];

  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-tabs-reorder-'));
    db = openDb(':memory:');
    events = new EventBus();
    seen = [];
    events.subscribe((e) => seen.push(e));
    test = await createTestApp({ db, dataDir: tmp, events });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function makeWorkspace(name: string): Promise<{ id: string }> {
    return (await (
      await test.app.request('/api/workspaces', { method: 'POST', ...json({ name }) })
    ).json()) as { id: string };
  }
  async function makeTab(workspaceId: string, name: string): Promise<Tab> {
    return (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: workspaceId, name }),
      })
    ).json()) as Tab;
  }
  const reorder = (ids: string[]) =>
    test.app.request('/api/tabs/reorder', { method: 'POST', ...json({ ids }) });
  const reordered = () => seen.filter((e) => e.type === 'tabs.reordered');

  it('emits one tabs.reordered naming the workspace the ids belong to', async () => {
    const ws = await makeWorkspace('Personal');
    const a = await makeTab(ws.id, 'a');
    const b = await makeTab(ws.id, 'b');
    seen.length = 0;

    const res = await reorder([b.id, a.id]);
    expect(res.status).toBe(204);

    const hits = reordered();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ type: 'tabs.reordered', workspace_id: ws.id });
  });

  it('carries no rows — a row-shaped event could not express a position change', async () => {
    // `Tab` has no `position`, and the client re-sorts using its CURRENT index
    // as the tiebreak, so per-row `tab.updated`s would faithfully reproduce the
    // order the client already holds. The event is deliberately coarse and the
    // handler re-fetches; if a future change starts attaching rows here, the
    // handler stops being idempotent and this is the place that should fail.
    const ws = await makeWorkspace('Personal');
    const a = await makeTab(ws.id, 'a');
    const b = await makeTab(ws.id, 'b');
    seen.length = 0;

    await reorder([b.id, a.id]);
    expect(Object.keys(reordered()[0] as object).sort()).toEqual(['type', 'workspace_id']);
    // And the reorder does NOT masquerade as row updates alongside it.
    expect(seen.filter((e) => e.type === 'tab.updated')).toHaveLength(0);
  });

  it('actually reorders — and PINNED is where that is visible at all', async () => {
    // Asserted on pinned rows deliberately. `orderedForWorkspace` returns the
    // pinned slice in `position` order and then sorts everything else by
    // activity (`compareUnpinnedTabs`), so an unpinned drag is a tiebreak the
    // list may legitimately override on the next message. The pinned block is
    // the slice where position is the WHOLE order — which is exactly why the
    // silent route was a real defect and not a cosmetic one.
    const ws = await makeWorkspace('Personal');
    const a = await makeTab(ws.id, 'a');
    const b = await makeTab(ws.id, 'b');
    for (const t of [a, b]) {
      await test.app.request(`/api/tabs/${t.id}`, { method: 'PATCH', ...json({ pinned: true }) });
    }

    await reorder([b.id, a.id]);
    const after = (await (
      await test.app.request(`/api/tabs?workspaceId=${ws.id}`)
    ).json()) as Tab[];
    expect(after.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('says nothing when there is nothing to say', async () => {
    // An empty list reorders nothing, so there is no workspace to name and no
    // client that needs waking. Emitting a workspace-less event here would
    // make every connected sidebar re-fetch for a no-op.
    seen.length = 0;
    const res = await reorder([]);
    expect(res.status).toBe(204);
    expect(reordered()).toHaveLength(0);
  });

  it('says nothing when the ids name no live row', async () => {
    // The id's row can vanish between the write and the lookup (a tab closed
    // on another device mid-drag). There is no workspace to resolve, and
    // guessing one would tell the wrong clients to re-fetch.
    seen.length = 0;
    const res = await reorder(['t_gone']);
    expect(res.status).toBe(204);
    expect(reordered()).toHaveLength(0);
  });
});
