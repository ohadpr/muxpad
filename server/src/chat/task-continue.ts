import type { Task } from './TaskStore.js';

/**
 * SHOULD muxpad HAND THIS TASK BACK? — the whole autonomy decision, as one
 * pure function with no database, no sockets and no model call.
 *
 * It is pure because it is the part that must never surprise anybody. An
 * agent that keeps working on its own is the single most expensive thing this
 * cockpit can do by itself: it spends tokens, it writes files, and it does so
 * while nobody is watching. Every condition below is therefore a reason to
 * STOP, and the default is to stop.
 */

/**
 * How many continuations one engagement buys.
 *
 * Six, which is a budget rather than a guess: the measured failure is a chat
 * that needed one or two more steps and had nobody to ask for them ("it
 * requires me in order to continue even if continuing is trivial"), not a
 * chat that needed sixty. And the budget is not the real stop condition —
 * `movedSince` is. A task making genuine progress gets its human back long
 * before six, because finishing is what the agent is being asked to do; a task
 * going in circles stops at two.
 */
export const CONTINUATION_LIMIT = 6;

export interface ContinueContext {
  /** Is a message already waiting for this chat? Then the queue IS the next
   *  step, and a continuation would jump a human's place in the line. */
  queued: number;
  /** Has the chat put a question to the user (a real pending tool question)?
   *  Continuing would be muxpad talking over the answer it is waiting for. */
  blocked: boolean;
  /** Did somebody Stop this turn? Stop means stop. It is not advice. */
  stopped: boolean;
  /** Did the turn end in a failure the runner reported? A crashed turn is not
   *  evidence of progress, and re-sending into a broken runner is a loop with
   *  a bill attached. The auth-heal and respawn paths own recovery; this does
   *  not compete with them. */
  turnFailed: boolean;
}

export type ContinueDecision =
  | { continue: true; attempt: number; limit: number }
  | { continue: false; why: string };

/**
 * `null` task → nothing to continue, which is the common case: a chat with no
 * declared task behaves exactly as it did before any of this existed. That is
 * the point of making the record explicit rather than inferring intent from
 * the conversation — an agent has to ASK for autonomy by writing a task down,
 * so nothing anybody has ever run changes behaviour until it does.
 */
export function shouldContinue(task: Task | null, ctx: ContinueContext): ContinueDecision {
  if (!task) return { continue: false, why: 'no open task' };
  if (task.state !== 'open') return { continue: false, why: `task is ${task.state}` };
  if (ctx.stopped) return { continue: false, why: 'the turn was stopped' };
  if (ctx.blocked) return { continue: false, why: 'the chat is waiting on a question' };
  if (ctx.turnFailed) return { continue: false, why: 'the turn ended in failure' };
  if (ctx.queued > 0) return { continue: false, why: 'work is already queued' };
  if (task.continuations >= CONTINUATION_LIMIT)
    return { continue: false, why: `continuation budget spent (${CONTINUATION_LIMIT})` };
  // ─── THE ANTI-LOOP, AND THE REASON THIS IS SAFE TO SHIP ──────────────────
  //
  // A continuation is earned by RECORDING PROGRESS. `continued_from` is the
  // `updated_at` the last continuation was sent against, so an untouched task
  // — same next step, no new evidence, nothing written — reads as a turn that
  // did nothing with the rope it was given, and gets no more.
  //
  // This is what stops the degenerate case that makes autonomy dangerous: an
  // agent that cannot make progress and does not know it would otherwise
  // bounce off the same wall six times at full model price. With this rule it
  // bounces exactly once, because the second decision sees an unmoved row.
  //
  // It also means the budget is rarely the thing that ends a run, which is the
  // right shape: the number is a backstop, the progress check is the rule.
  if (task.continued_from !== null && task.updated_at <= task.continued_from)
    return { continue: false, why: 'nothing was recorded since the last continuation' };
  return { continue: true, attempt: task.continuations + 1, limit: CONTINUATION_LIMIT };
}
