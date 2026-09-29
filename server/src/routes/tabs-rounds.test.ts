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
import type { SpawnRound } from '@muxpad/shared';
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
    return (await res.json()) as { rounds: Record<string, SpawnRound[]> };
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
    expect(await get(child)).toEqual({ rounds: {} });
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
});
