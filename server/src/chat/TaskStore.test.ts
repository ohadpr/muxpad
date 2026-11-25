import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../store/migrations.js';
import { TaskStore } from './TaskStore.js';

let db: Database.Database;
let now = 1_000;
let tasks: TaskStore;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('w1', 'w', 'W', 0, 0, 0);
  const tab = db.prepare(
    'INSERT INTO tabs (id, slug, name, layout, workspace_id, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  tab.run('tab1', 's1', 'A', '"p"', 'w1', 0, 0, 0);
  tab.run('tab2', 's2', 'B', '"p"', 'w1', 1, 0, 0);
  now = 1_000;
  tasks = new TaskStore(db, () => now);
});

describe('a declared task', () => {
  it('starts open, with the chat’s own words kept verbatim', () => {
    const t = tasks.create('tab1', {
      request: 'ship the sidebar fix',
      criteria: 'suite green',
      next_step: 'run the migration',
    });
    expect(t.state).toBe('open');
    expect(t.request).toBe('ship the sidebar fix');
    expect(t.criteria).toBe('suite green');
    expect(t.continuations).toBe(0);
    expect(t.continued_from).toBeNull();
    expect(tasks.openFor('tab1')?.id).toBe(t.id);
  });

  it('is scoped to its chat', () => {
    tasks.create('tab1', { request: 'mine' });
    expect(tasks.openFor('tab2')).toBeNull();
  });

  it('needs no criteria — a weaker end condition is still a task', () => {
    const t = tasks.create('tab1', { request: 'poke at it' });
    expect(t.criteria).toBeNull();
    expect(t.next_step).toBeNull();
  });
});

describe('the lifecycle', () => {
  it('records a next step and moves updated_at, because that is the progress signal', () => {
    const t = tasks.create('tab1', { request: 'r' });
    now = 5_000;
    tasks.setNextStep(t.id, 'measure the drain latency');
    const after = tasks.get(t.id);
    expect(after?.next_step).toBe('measure the drain latency');
    expect(after?.updated_at).toBe(5_000);
  });

  it('finishes with evidence, and stops being the open task', () => {
    const t = tasks.create('tab1', { request: 'r' });
    now = 6_000;
    tasks.finish(t.id, 'commit 2e221f76, three clean runs');
    expect(tasks.get(t.id)?.state).toBe('done');
    expect(tasks.get(t.id)?.evidence).toBe('commit 2e221f76, three clean runs');
    expect(tasks.get(t.id)?.closed_at).toBe(6_000);
    expect(tasks.openFor('tab1')).toBeNull();
  });

  it('blocks with the question, and reopens when it is answered', () => {
    const t = tasks.create('tab1', { request: 'r' });
    tasks.block(t.id, 'which account should it bill?');
    expect(tasks.get(t.id)?.state).toBe('blocked');
    expect(tasks.openFor('tab1')).toBeNull();
    tasks.reopen(t.id);
    expect(tasks.get(t.id)?.state).toBe('open');
    expect(tasks.get(t.id)?.closed_at).toBeNull();
  });

  it('will not resurrect a task that was DONE', () => {
    // `reopen` exists for the blocked case only: a finished task coming back
    // to life would make "done" meaningless and could continue work the chat
    // has already reported as delivered.
    const t = tasks.create('tab1', { request: 'r' });
    tasks.finish(t.id, 'evidence');
    tasks.reopen(t.id);
    expect(tasks.get(t.id)?.state).toBe('done');
  });

  // DONE IS TERMINAL; BLOCKED IS NOT. This pair used to be one test asserting
  // that blocked → done was a refused "second close", which read as caution
  // and was a bug: `task done <blocked-id>` reported success, changed nothing,
  // and the row stayed blocked — so a later human message reopened work the
  // user had already settled. Blocked means it stopped to ASK, and one of the
  // answers is "that is finished".
  it('lets a blocked task be finished — stopping to ask is not a close', () => {
    const t = tasks.create('tab1', { request: 'r' });
    tasks.block(t.id, 'needs a decision');
    expect(tasks.finish(t.id, 'settled in the meeting')).toBe(true);
    expect(tasks.get(t.id)?.state).toBe('done');
    expect(tasks.get(t.id)?.evidence).toBe('settled in the meeting');
  });

  it('refuses to reopen or rewrite a DONE task, and says it changed nothing', () => {
    const t = tasks.create('tab1', { request: 'r' });
    tasks.finish(t.id, 'first');
    expect(tasks.finish(t.id, 'second')).toBe(false);
    tasks.block(t.id, 'second');
    tasks.reopen(t.id);
    expect(tasks.get(t.id)?.state).toBe('done');
    expect(tasks.get(t.id)?.evidence).toBe('first');
  });
});

/**
 * WHAT A HUMAN SPEAKING BRINGS BACK. "Blocked" means the chat stopped to ask,
 * so a human saying anything should resume it — but a review found the
 * caller searching the last five rows for anything blocked, which resurrected
 * work two tasks stale and let the next turn continue it automatically.
 */
describe('reopening what a human answered', () => {
  it('brings back the blocked task when it is still the live one', () => {
    const t = tasks.create('tab1', { request: 'r' });
    tasks.block(t.id, 'which account?');
    expect(tasks.reopenLatestBlocked('tab1')).toBe(true);
    expect(tasks.get(t.id)?.state).toBe('open');
  });

  it('leaves a blocked task shut once newer work has come and gone', () => {
    const stale = tasks.create('tab1', { request: 'the old job' });
    tasks.block(stale.id, 'which account?');
    now += 1000;
    const newer = tasks.create('tab1', { request: 'something else' });
    tasks.finish(newer.id, 'shipped');
    expect(tasks.reopenLatestBlocked('tab1')).toBe(false);
    expect(tasks.get(stale.id)?.state).toBe('blocked');
  });

  it('does nothing in a chat whose latest task is open, or which has none', () => {
    expect(tasks.reopenLatestBlocked('tab-empty')).toBe(false);
    const t = tasks.create('tab1', { request: 'r' });
    expect(tasks.reopenLatestBlocked('tab1')).toBe(false);
    expect(tasks.get(t.id)?.state).toBe('open');
  });
});

describe('the continuation budget', () => {
  it('remembers the updated_at it was spent against', () => {
    const t = tasks.create('tab1', { request: 'r' });
    now = 3_000;
    tasks.setNextStep(t.id, 'step');
    tasks.noteContinuation(t.id);
    const after = tasks.get(t.id);
    expect(after?.continuations).toBe(1);
    // THE ANTI-LOOP'S INPUT: equal to updated_at means "nothing has moved
    // since", which is what makes a stalled task stop asking.
    expect(after?.continued_from).toBe(3_000);
  });

  it('starts over when a human engages, and only for the OPEN task', () => {
    const open = tasks.create('tab1', { request: 'open one' });
    tasks.noteContinuation(open.id);
    tasks.noteContinuation(open.id);
    const other = tasks.create('tab2', { request: 'another chat' });
    tasks.noteContinuation(other.id);

    tasks.resetBudget('tab1');
    expect(tasks.get(open.id)?.continuations).toBe(0);
    expect(tasks.get(open.id)?.continued_from).toBeNull();
    // Another chat's budget is not touched.
    expect(tasks.get(other.id)?.continuations).toBe(1);
  });

  it('does not rewrite the history of closed tasks', () => {
    const closed = tasks.create('tab1', { request: 'old' });
    tasks.noteContinuation(closed.id);
    tasks.finish(closed.id, 'done');
    tasks.create('tab1', { request: 'new' });
    tasks.resetBudget('tab1');
    expect(tasks.get(closed.id)?.continuations).toBe(1);
  });
});
