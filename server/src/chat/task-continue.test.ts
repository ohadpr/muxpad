import { describe, expect, it } from 'vitest';
import type { Task } from './TaskStore.js';
import { CONTINUATION_LIMIT, type ContinueContext, shouldContinue } from './task-continue.js';

/**
 * THE AUTONOMY DECISION, which is the part that must never surprise anybody.
 *
 * Every test here is a reason to STOP, because the expensive direction is
 * continuing: an agent handed its task back spends tokens and writes files
 * while nobody is watching. The one test that asserts `continue: true` is the
 * narrow case all the others carve out.
 */
const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  tab_id: 'tab1',
  request: 'ship the sidebar fix',
  origin: 'agent',
  criteria: 'suite green and the row order verified',
  next_step: 'run the migration against a copy',
  state: 'open',
  evidence: null,
  created_at: 1_000,
  updated_at: 2_000,
  closed_at: null,
  continuations: 0,
  continued_from: null,
  ...over,
});

const ctx = (over: Partial<ContinueContext> = {}): ContinueContext => ({
  queued: 0,
  blocked: false,
  stopped: false,
  turnFailed: false,
  ...over,
});

describe('when muxpad hands a task back', () => {
  it('continues an open task that has recorded progress', () => {
    expect(shouldContinue(task(), ctx())).toEqual({
      continue: true,
      attempt: 1,
      limit: CONTINUATION_LIMIT,
    });
  });

  it('counts attempts up from what has already been spent', () => {
    const d = shouldContinue(task({ continuations: 3, continued_from: 1_500 }), ctx());
    expect(d).toEqual({ continue: true, attempt: 4, limit: CONTINUATION_LIMIT });
  });
});

describe('every reason not to', () => {
  it('does nothing for a chat with no task — which is every chat, until one is declared', () => {
    // The safety property of the whole feature: nothing anybody has ever run
    // changes behaviour until an agent writes a task down.
    expect(shouldContinue(null, ctx())).toEqual({ continue: false, why: 'no open task' });
  });

  it('leaves a done or blocked task alone', () => {
    expect(shouldContinue(task({ state: 'done' }), ctx()).continue).toBe(false);
    expect(shouldContinue(task({ state: 'blocked' }), ctx()).continue).toBe(false);
  });

  it('obeys Stop', () => {
    // Stop is not advice. A continuation after one would be muxpad restarting
    // work a person just cut off.
    expect(shouldContinue(task(), ctx({ stopped: true }))).toEqual({
      continue: false,
      why: 'the turn was stopped',
    });
  });

  it('does not talk over a question the chat already asked', () => {
    expect(shouldContinue(task(), ctx({ blocked: true })).continue).toBe(false);
  });

  it('yields to work already in the queue', () => {
    // The queue IS the next step, and a human's message is usually what is in
    // it — continuing here would jump their place in the line.
    expect(shouldContinue(task(), ctx({ queued: 1 }))).toEqual({
      continue: false,
      why: 'work is already queued',
    });
  });

  it('does not re-send into a turn that failed', () => {
    // A crashed turn is not evidence of progress, and the auth-heal and
    // respawn paths own recovery. Competing with them is a loop with a bill.
    expect(shouldContinue(task(), ctx({ turnFailed: true })).continue).toBe(false);
  });

  it('stops at the budget', () => {
    const d = shouldContinue(
      task({ continuations: CONTINUATION_LIMIT, continued_from: 1_500 }),
      ctx(),
    );
    expect(d).toEqual({
      continue: false,
      why: `continuation budget spent (${CONTINUATION_LIMIT})`,
    });
  });

  it('STOPS AFTER ONE when nothing was recorded — the anti-loop', () => {
    // The degenerate case that makes autonomy dangerous: an agent that cannot
    // make progress and does not know it, bouncing off the same wall at full
    // model price. A continuation is EARNED by recording progress, so an
    // untouched task gets exactly one retry and then silence.
    const stalled = task({ continuations: 1, continued_from: 2_000, updated_at: 2_000 });
    expect(shouldContinue(stalled, ctx())).toEqual({
      continue: false,
      why: 'nothing was recorded since the last continuation',
    });
    // …and one byte of recorded progress revives it.
    expect(shouldContinue({ ...stalled, updated_at: 2_001 }, ctx()).continue).toBe(true);
  });

  it('is the BUDGET that is the backstop and the progress check that is the rule', () => {
    // Stated as a test because it is the shape of the design: a task that keeps
    // moving can use all six, a task that stops moving cannot reach two.
    let t = task();
    let used = 0;
    for (let i = 0; i < 20; i++) {
      const d = shouldContinue(t, ctx());
      if (!d.continue) break;
      used++;
      t = { ...t, continuations: t.continuations + 1, continued_from: t.updated_at };
      t = { ...t, updated_at: t.updated_at + 10 }; // progress recorded
    }
    expect(used).toBe(CONTINUATION_LIMIT);
  });
});
