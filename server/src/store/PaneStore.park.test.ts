import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PaneStore } from './PaneStore.js';
import { runMigrations } from './migrations.js';

/** Parking state on a pane — see agent-park.ts for the policy that uses it. */
describe('PaneStore parking', () => {
  let db: Database.Database;
  let panes: PaneStore;
  const NOW = 1_800_000_000_000;

  const tab = (id: string, over: { spawned_by?: string; retired?: boolean } = {}) =>
    db
      .prepare(
        `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at,
                           spawned_by, retired_at, last_activity_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        id,
        id,
        JSON.stringify(`p-${id}`),
        'w1',
        NOW,
        NOW,
        over.spawned_by ?? null,
        over.retired ? NOW : null,
        NOW,
      );

  const pane = (id: string, tabId: string, cmd = 'muxpad agent') =>
    db
      .prepare('INSERT INTO panes (id, tab_id, shell, startup_cmd, created_at) VALUES (?,?,?,?,?)')
      .run(id, tabId, '/bin/zsh', cmd, NOW);

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('w1', 'w1', 'W', NOW, NOW);
    panes = new PaneStore(db);
  });

  it('parks and unparks', () => {
    tab('t1');
    pane('p1', 't1');
    expect(panes.isParked('p1')).toBe(false);
    panes.park('p1', NOW);
    expect(panes.isParked('p1')).toBe(true);
    expect(panes.unpark('p1')).toBe(true);
    expect(panes.isParked('p1')).toBe(false);
  });

  it('unpark says FALSE for a pane that was never parked', () => {
    // SQLite counts rows matched, not values changed. Without the guard this
    // returns true for every send and the chat announces "waking" each time.
    tab('t1');
    pane('p1', 't1');
    expect(panes.unpark('p1')).toBe(false);
    panes.park('p1', NOW);
    expect(panes.unpark('p1')).toBe(true);
    expect(panes.unpark('p1')).toBe(false); // already awake
  });

  it('lists candidates with the facts the decision needs', () => {
    tab('t1');
    pane('p1', 't1');
    db.prepare(
      "INSERT INTO agent_sessions (id, pane_id, assistant, status, created_at, updated_at) VALUES ('s1','p1','claude','idle',?,?)",
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO agent_queue (id, pane_id, seq, text, created_at) VALUES ('q','p1',1,'hi',?)",
    ).run(NOW);
    const [c] = panes.listParkCandidates();
    expect(c).toMatchObject({
      status: 'idle',
      queued: 1,
      openRounds: 0,
      isSubChat: false,
      parked: false,
    });
    expect(c?.lastActivityAt).toBe(NOW);
  });

  it('counts a sub-chat as one, and an open round as open', () => {
    tab('parent');
    tab('kid', { spawned_by: 'parent' });
    pane('p-kid', 'kid');
    db.prepare("INSERT INTO spawn_rounds (id, tab_id, started_at) VALUES ('r','kid',?)").run(NOW);
    const c = panes.listParkCandidates().find((x) => x.pane.id === 'p-kid');
    expect(c).toMatchObject({ isSubChat: true, openRounds: 1 });
  });

  it('ignores panes that are not agents', () => {
    tab('t1');
    pane('shell', 't1', '/bin/zsh');
    expect(panes.listParkCandidates().map((c) => c.pane.id)).toEqual([]);
  });

  it('INCLUDES a retired tab, flagged — they are the point', () => {
    // `listAgentPanes` excludes retired tabs so they are never auto-started;
    // that is the same fact read the other way round, which makes them the
    // safest processes on the machine to stop. Measured: 84 of 123 runners.
    tab('gone', { retired: true });
    pane('p-gone', 'gone');
    const c = panes.listParkCandidates().find((x) => x.pane.id === 'p-gone');
    expect(c).toBeTruthy();
    expect(c?.retired).toBe(true);
  });
});
