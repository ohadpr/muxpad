import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { SpawnRoundStore } from './SpawnRoundStore.js';
import { TabStore } from './TabStore.js';
import { WorkspaceStore } from './WorkspaceStore.js';
import { runMigrations } from './migrations.js';

/**
 * A WORKER IS A SEQUENCE OF ROUNDS.
 *
 * "if the chat has progressed then it doesn't help much to update the original
 * card" was answered with two entries per child — a launch at `created_at`, a
 * completion at `retired_at`. Both are one pair per TAB, and a worker is handed
 * successive jobs: `muxpad agent send` revives the retired chat and starts fresh
 * work. Measured on the real database, the chat writing this had FIVE user
 * messages against that single pair, so four rounds were invisible.
 */
describe('SpawnRoundStore', () => {
  let db: Database.Database;
  let rounds: SpawnRoundStore;
  let child: string;
  let parent: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const tabs = new TabStore(db);
    const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
    parent = tabs.create({ name: 'muxpad', layout: '', workspace_id: ws }).id;
    child = tabs.create({
      name: 'card-summary',
      layout: '',
      workspace_id: ws,
      spawned_by: parent,
    }).id;
    rounds = new SpawnRoundStore(db);
  });

  it('records a round per handover', () => {
    rounds.open(child, 100);
    rounds.close(child, 200);
    rounds.open(child, 300);
    rounds.close(child, 400);
    expect(rounds.listByTab(child).map((r) => [r.started_at, r.ended_at])).toEqual([
      [100, 200],
      [300, 400],
    ]);
  });

  it('IS IDEMPOTENT WHILE A ROUND IS OPEN', () => {
    // The safety of hanging this on `noteUserMessage`, which fires for EVERY
    // message into an agent pane: three lines typed while the worker is mid-turn
    // are one round, not three. The queue delivers them to the same turn.
    expect(rounds.open(child, 100)).not.toBeNull();
    expect(rounds.open(child, 110)).toBeNull();
    expect(rounds.open(child, 120)).toBeNull();
    expect(rounds.listByTab(child)).toHaveLength(1);
  });

  it('opens a NEW round once the last one closed — that is the revival', () => {
    rounds.open(child, 100);
    rounds.close(child, 200);
    expect(rounds.open(child, 300)).not.toBeNull();
    expect(rounds.listByTab(child)).toHaveLength(2);
  });

  it('closing with no round open is a no-op, not an invented round', () => {
    // Every worker that existed before this table finishes turns with nothing to
    // close. A round with no beginning would be worse than no round.
    expect(rounds.close(child, 200)).toBe(false);
    expect(rounds.listByTab(child)).toEqual([]);
  });

  it('ATTACHES THE RESULT TO THE ROUND THAT ENDED, not the one now open', () => {
    // The report is a model call of up to thirty seconds and the round closes
    // synchronously at turn-end, so the sentences always arrive after the round
    // they describe has closed. If the worker has already been re-tasked by
    // then, the result must not land on the new round.
    rounds.open(child, 100);
    rounds.close(child, 200);
    rounds.open(child, 300);
    rounds.writeResult(child, { report: 'Found 2 dead rules.', state: 'ok' });
    const all = rounds.listByTab(child);
    expect(all[0]?.report).toBe('Found 2 dead rules.');
    expect(all[1]?.report).toBeNull();
  });

  it('never ERASES what an earlier write found', () => {
    // A later round that produces no artifacts must not delete the link an
    // earlier one published, and a refused summary must not wipe a good one.
    rounds.open(child, 100);
    rounds.close(child, 200, {
      report: 'Published it.',
      state: 'ok',
      artifacts: ['https://x.test/p/'],
    });
    rounds.writeResult(child, { report: 'Published it.', state: 'ok' });
    expect(rounds.listByTab(child)[0]?.artifacts).toEqual(['https://x.test/p/']);
  });

  it('reads a malformed artifact list as none rather than throwing', () => {
    rounds.open(child, 100);
    rounds.close(child, 200);
    db.prepare('UPDATE spawn_rounds SET artifacts = ? WHERE tab_id = ?').run('{not json', child);
    expect(rounds.listByTab(child)[0]?.artifacts).toEqual([]);
  });

  it('answers for a WHOLE CONVERSATION in one query', () => {
    // A parent with thirty children is the case this exists for; thirty round
    // trips to draw one log is the problem the corpus already solved once.
    const tabs = new TabStore(db);
    const ws = new WorkspaceStore(db).list()[0]?.id as string;
    const sibling = tabs.create({
      name: 'dead-css',
      layout: '',
      workspace_id: ws,
      spawned_by: parent,
    }).id;
    const stranger = tabs.create({ name: 'elsewhere', layout: '', workspace_id: ws }).id;
    rounds.open(child, 100);
    rounds.close(child, 200);
    rounds.open(sibling, 150);
    rounds.open(stranger, 160);

    const byChild = rounds.listByParent(parent);
    expect([...byChild.keys()].sort()).toEqual([child, sibling].sort());
    expect(byChild.get(stranger)).toBeUndefined();
  });

  it('knows which round is still running', () => {
    expect(rounds.openRound(child)).toBeNull();
    rounds.open(child, 100);
    expect(rounds.openRound(child)?.started_at).toBe(100);
    rounds.close(child, 200);
    expect(rounds.openRound(child)).toBeNull();
  });
});
