// GET /api/tabs/:id/spawn-rounds — every round of every child, in one request.
//
// A worker is handed successive jobs, and each one is a ROUND with its own pair
// of cards in the parent's log. The rounds cannot ride the tab row: that is
// polled every five seconds for the whole sidebar, and a report is up to 800
// characters × every round × every child. So the conversation asks for them
// once, for all of its children at a time.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnRound, Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpawnRoundStore } from '../store/SpawnRoundStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('GET /api/tabs/:id/spawn-rounds', () => {
  let test: TestApp;
  let db: Database.Database;
  let tmp: string;
  let parent: string;
  let child: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-rounds-'));
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
    const tabs = new TabStore(db);
    const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
    parent = tabs.create({ name: 'muxpad', layout: '', workspace_id: ws }).id;
    child = tabs.create({
      name: 'card-summary',
      layout: '',
      workspace_id: ws,
      spawned_by: parent,
    }).id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const get = async (id: string) => {
    const res = await test.app.request(`/api/tabs/${id}/spawn-rounds`);
    return (await res.json()) as {
      rounds: Record<string, SpawnRound[]>;
      children: Array<{ id: string; slug: string; name: string; tabs: Tab[] }>;
    };
  };

  it('returns every round of every child, keyed by child', async () => {
    const rounds = new SpawnRoundStore(db);
    rounds.open(child, 100);
    rounds.close(child, 200, { report: 'Found 2 dead rules.', state: 'ok' });
    rounds.open(child, 300);

    const body = await get(parent);
    expect(body.rounds[child]?.map((r) => [r.started_at, r.ended_at, r.report])).toEqual([
      [100, 200, 'Found 2 dead rules.'],
      [300, null, null],
    ]);
  });

  it('is empty for a chat that has spawned nothing', async () => {
    expect(await get(child)).toEqual({ rounds: {}, children: [] });
  });

  it('does not leak another parent’s children', async () => {
    const tabs = new TabStore(db);
    const ws = new WorkspaceStore(db).list()[0]?.id as string;
    const other = tabs.create({ name: 'elsewhere', layout: '', workspace_id: ws }).id;
    const theirs = tabs.create({
      name: 'not-mine',
      layout: '',
      workspace_id: ws,
      spawned_by: other,
    }).id;
    const rounds = new SpawnRoundStore(db);
    rounds.open(child, 100);
    rounds.open(theirs, 100);

    const body = await get(parent);
    expect(Object.keys(body.rounds)).toEqual([child]);
  });

  // ── THE CHILDREN, for a corpus that no longer carries finished work ─────────
  describe('children', () => {
    const childIds = (body: Awaited<ReturnType<typeof get>>) =>
      body.children.flatMap((g) => g.tabs.map((t) => t.id));

    it('lists a RETIRED child — the one the live corpus drops', async () => {
      new TabStore(db).retire(child, 'delivered', 500);
      const body = await get(parent);
      const row = body.children[0]?.tabs[0] as Tab & { done?: boolean; done_reason?: string };
      expect(row?.id).toBe(child);
      expect(row?.name).toBe('card-summary');
      expect(row?.done).toBe(true);
      expect(row?.done_reason).toBe('delivered');
    });

    it('lists a child with NO rounds at all (legacy, never messaged)', async () => {
      const body = await get(parent);
      expect(body.rounds).toEqual({});
      expect(childIds(body)).toEqual([child]);
    });

    it('is grouped like /all: the workspace id, slug and name ride with the rows', async () => {
      const ws = new WorkspaceStore(db).list()[0];
      const body = await get(parent);
      expect(body.children.map((g) => [g.id, g.slug, g.name])).toEqual([[ws?.id, ws?.slug, 'W']]);
    });

    it('carries the WHOLE tab-level report, not the corpus excerpt', async () => {
      const long = `${'x'.repeat(600)} the end.`;
      new TabStore(db).setSpawnReport(child, { report: long, state: 'ok' }, 400);
      const row = (await get(parent)).children[0]?.tabs[0];
      expect(row?.spawn_report).toBe(long);
      expect(row?.spawn_report_state).toBe('ok');
    });

    it('lists only DIRECT children of this parent, never itself or a grandchild', async () => {
      const tabs = new TabStore(db);
      const ws = new WorkspaceStore(db).list()[0]?.id as string;
      const grandchild = tabs.create({
        name: 'grandchild',
        layout: '',
        workspace_id: ws,
        spawned_by: child,
      }).id;
      const other = tabs.create({ name: 'elsewhere', layout: '', workspace_id: ws }).id;
      tabs.create({ name: 'not-mine', layout: '', workspace_id: ws, spawned_by: other });
      db.prepare('UPDATE tabs SET spawned_by = id WHERE id = ?').run(parent);
      const ids = childIds(await get(parent));
      expect(ids).toEqual([child]);
      expect(ids).not.toContain(grandchild);
    });

    it('drops a DELETED child along with its rounds', async () => {
      new SpawnRoundStore(db).open(child, 100);
      new TabStore(db).delete(child);
      expect(await get(parent)).toEqual({ rounds: {}, children: [] });
    });
  });
});
