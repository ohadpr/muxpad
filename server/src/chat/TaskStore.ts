import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/**
 * A TASK THAT OUTLIVES THE TURN THAT STARTED IT.
 *
 * ─── THE FRICTION, MEASURED ─────────────────────────────────────────────────
 * Five separate requests across 11/04, 11/07, 11/08, 11/09 and 11/13 ask for
 * the same thing in different words: keep working without being babysat. On
 * 11/08, verbatim: "it requires me in order to continue even if continuing is
 * trivial". On 11/09 a chat was commissioned to be the babysitter; it declared
 * itself finished and paused its own cron before the first fire, and a review
 * the next morning found six remaining defects.
 *
 * A turn ending is not a job ending, and until this existed muxpad had no
 * record of the difference. The conversation held the goal, the harness held
 * the turn, and nothing held the TASK — so every gap between "the model
 * stopped emitting" and "the work is done" needed a human to notice.
 *
 * ─── WHY A ROW AND NOT A PROMPT ─────────────────────────────────────────────
 * "Better instructions" was the first proposal and it is where this started:
 * an agent told to keep going does keep going, right up until the turn ends —
 * and then there is nobody to tell. Instructions cannot survive the end of the
 * context they live in. A row can.
 *
 * ─── WHO DECIDES THE WORK IS DONE: THE CHAT ITSELF ──────────────────────────
 * Every field here is written BY the agent, through `muxpad task`. muxpad never
 * asks a model whether the work is finished and never spawns a reviewer to
 * judge it. That is deliberate and it is the lesson of the sub-agent work:
 * a judge needs the whole conversation to say anything useful about "is this
 * done", at which point it is the same agent with a worse view. So the server's
 * entire contribution is bookkeeping — this task is open, you said your next
 * step was X, here it is back — and the judgement stays in the one loop that
 * has the context.
 *
 * `state` is the whole lifecycle:
 *
 *   open     the chat says there is work left. The only state that continues.
 *   done     the chat says it is finished, WITH evidence. Nothing further.
 *   blocked  the chat says it needs the user. Nothing further until a human
 *            answers — a continuation here would be muxpad talking over the
 *            question it is waiting for.
 */
export interface Task {
  id: string;
  tab_id: string;
  /** What was asked for, in the chat's own words. The anchor: a continuation
   *  reads this back rather than paraphrasing the goal. */
  request: string;
  /** What "finished" means, so the agent can check ITSELF. Null when the chat
   *  never said — a task with no criteria still continues, it just has a
   *  weaker end condition than one that named it. */
  criteria: string | null;
  /** The concrete next action, rewritten as work proceeds. Also the progress
   *  signal: see `moved_since`. */
  next_step: string | null;
  state: 'open' | 'done' | 'blocked';
  /** What proves it is done / what the user has to settle. */
  evidence: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  /** How many continuations this task has already been handed. Bounded. */
  continuations: number;
  /** `updated_at` as it was when the last continuation went out, so the next
   *  decision can ask whether anything moved. Null before the first. */
  continued_from: number | null;
}

export interface TaskWrite {
  request: string;
  criteria?: string | null;
  next_step?: string | null;
}

export class TaskStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(tabId: string, w: TaskWrite): Task {
    const id = ulid();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, tab_id, request, criteria, next_step, state, evidence,
           created_at, updated_at, closed_at, continuations, continued_from)
         VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL, 0, NULL)`,
      )
      .run(id, tabId, w.request, w.criteria ?? null, w.next_step ?? null, at, at);
    return this.get(id) as Task;
  }

  get(id: string): Task | null {
    return (
      (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined) ?? null
    );
  }

  /**
   * The ONE open task of a chat, or null.
   *
   * One, not a list, and that is a product decision rather than a schema
   * limitation: a chat with three open tasks has no answer to "what are you
   * doing now", and a continuation that had to pick between them would be
   * choosing the user's priorities for them. `open` on a new task closes the
   * previous one as superseded (see `create` callers), so the invariant holds
   * without a constraint that would make the history unwritable.
   */
  openFor(tabId: string): Task | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM tasks WHERE tab_id = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1",
        )
        .get(tabId) as Task | undefined) ?? null
    );
  }

  listFor(tabId: string, limit = 20): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE tab_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(tabId, limit) as Task[];
  }

  /** Record the next concrete step. This is the progress signal the continuation
   *  budget is spent against, so it moves `updated_at` on purpose. */
  setNextStep(id: string, next: string): void {
    this.db
      .prepare("UPDATE tasks SET next_step = ?, updated_at = ? WHERE id = ? AND state = 'open'")
      .run(next, this.now(), id);
  }

  /** Finished, with what proves it. Evidence is required by the CLI rather than
   *  by the schema: "done" with nothing to point at is the failure mode this
   *  whole thing exists for (11/09: a chat declared completion, six defects
   *  remained), but a row written by an older client must still be storable. */
  finish(id: string, evidence: string | null): void {
    const at = this.now();
    this.db
      .prepare(
        "UPDATE tasks SET state = 'done', evidence = ?, updated_at = ?, closed_at = ? WHERE id = ? AND state = 'open'",
      )
      .run(evidence, at, at, id);
  }

  block(id: string, why: string): void {
    const at = this.now();
    this.db
      .prepare(
        "UPDATE tasks SET state = 'blocked', evidence = ?, updated_at = ?, closed_at = ? WHERE id = ? AND state = 'open'",
      )
      .run(why, at, at, id);
  }

  /** A blocked task the user has now answered goes back to work. The continuation
   *  budget is NOT reset here — `noteUserMessage` does that, because the fact
   *  that earns more rope is a human engaging, not a state change. */
  reopen(id: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET state = 'open', updated_at = ?, closed_at = NULL WHERE id = ? AND state = 'blocked'",
      )
      .run(this.now(), id);
  }

  /** Stamp a continuation as sent: one more spent, and remember the
   *  `updated_at` it was sent against so "did anything move" is answerable. */
  noteContinuation(id: string): void {
    this.db
      .prepare(
        'UPDATE tasks SET continuations = continuations + 1, continued_from = updated_at WHERE id = ?',
      )
      .run(id);
  }

  /** A human spoke in this chat: the budget starts over. Somebody engaged is
   *  the one event that makes more autonomous continuations reasonable again —
   *  and without it, a long-running chat would spend its six once and never
   *  continue anything again for the rest of its life. */
  resetBudget(tabId: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET continuations = 0, continued_from = NULL WHERE tab_id = ? AND state = 'open'",
      )
      .run(tabId);
  }
}
