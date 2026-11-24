import type { Workspace } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PtydCache, decorateWorkspace } from './ptyd-cache.js';
import { runMigrations } from './store/migrations.js';

/**
 * THE WORKSPACE ROLLUP — "is anything running in here?" for a collapsed
 * workspace, which has nothing mounted to observe its own tabs.
 *
 * It had NO test, and its panes were read with a `listByTab` per tab: 1,454
 * prepared-statement round trips to answer a 763-byte question, on a route
 * every device re-polls whenever any pane changes state. Swapped for the
 * grouped `byTabForWorkspace` that already existed for the same reason one
 * scale down.
 *
 * These assertions exist because that swap must be invisible. Nothing about
 * WHAT is counted may change — the same tabs, the same panes, the same
 * precedence — and the only honest way to say so is to pin the answers.
 */
let db: Database.Database;

const ws = (id: string): Workspace =>
  ({ id, slug: id, name: id, position: 0 }) as unknown as Workspace;

const mkWs = (id: string) =>
  db
    .prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,0,0,0)',
    )
    .run(id, id, id);

const mkTab = (id: string, wsId: string, unread = 0) =>
  db
    .prepare(
      `INSERT INTO tabs (id, slug, name, workspace_id, layout, position, created_at, updated_at, unread)
       VALUES (?,?,?,?,'{}',0,0,0,?)`,
    )
    .run(id, `s-${id}`, id, wsId, unread);

const mkPane = (id: string, tabId: string) =>
  db
    .prepare(`INSERT INTO panes (id, tab_id, kind, cwd, created_at) VALUES (?,?,'shell','/tmp',0)`)
    .run(id, tabId);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  mkWs('w1');
});

describe('decorateWorkspace', () => {
  it('is quiet when nothing in it is doing anything', () => {
    mkTab('t1', 'w1');
    mkPane('p1', 't1');
    const out = decorateWorkspace(new PtydCache(), db, ws('w1'));
    expect(out.attention).toBeFalsy();
    expect(out.unread).toBeFalsy();
    expect(out.agents).toBe(0);
  });

  it('finds a working pane through its tab, not through the tab it was asked about', () => {
    // The whole point of the rollup: the workspace is collapsed, so the only
    // way it can know is by looking at every pane under it.
    mkTab('t1', 'w1');
    mkTab('t2', 'w1');
    mkPane('p1', 't1');
    mkPane('p2', 't2');
    const cache = new PtydCache();
    cache.setAgentBusy('p2', true);
    expect(decorateWorkspace(cache, db, ws('w1')).status).toBe('working');
  });

  it('rolls up across MANY tabs — the case the grouped query changed', () => {
    for (let i = 0; i < 40; i++) {
      mkTab(`t${i}`, 'w1');
      mkPane(`p${i}`, `t${i}`);
    }
    const cache = new PtydCache();
    // The one that matters is last, so a query that returned only the first
    // tab's panes — or grouped them under the wrong tab — would miss it.
    cache.setBlocked('p39', true);
    const out = decorateWorkspace(cache, db, ws('w1'));
    expect(out.status).toBe('blocked');
  });

  it('counts a pane’s subagents ONCE, which is what the grouping protects', () => {
    // The rollup unions statuses, so mis-bucketing the grouped result set —
    // handing every tab every pane — produces the same status and no test of
    // status can see it. `agents` is the one output that ADDS, so it is the
    // one that catches it: two tabs, one pane with two subagents, and a
    // pooled read would report four.
    //
    // Written after sabotaging the obvious test and watching it stay green.
    mkTab('t1', 'w1');
    mkTab('t2', 'w1');
    mkPane('p1', 't1');
    const cache = new PtydCache();
    cache.setSubagentCount('p1', 2);
    expect(decorateWorkspace(cache, db, ws('w1')).agents).toBe(2);
  });

  it('does not count panes from another workspace', () => {
    mkWs('w2');
    mkTab('t1', 'w1');
    mkPane('p1', 't1');
    mkTab('t2', 'w2');
    mkPane('p2', 't2');
    const cache = new PtydCache();
    cache.setAgentBusy('p2', true);
    expect(decorateWorkspace(cache, db, ws('w1')).status).not.toBe('working');
  });

  it('carries a blocked pane up as the workspace’s state', () => {
    mkTab('t1', 'w1');
    mkPane('p1', 't1');
    const cache = new PtydCache();
    cache.setBlocked('p1', true);
    expect(decorateWorkspace(cache, db, ws('w1')).status).toBe('blocked');
  });

  it('a manually unread tab counts even with no pane to speak for it', () => {
    mkTab('t1', 'w1', 1);
    expect(decorateWorkspace(new PtydCache(), db, ws('w1')).unread).toBe(true);
  });
});
