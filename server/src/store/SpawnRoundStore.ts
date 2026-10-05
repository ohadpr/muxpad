import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { SpawnReportWrite } from './TabStore.js';

const ulid = monotonicFactory();

/**
 * ONE ROUND of a worker's life: given a job, finished that job.
 *
 * A sub-chat is not one job. It is handed successive ones — `muxpad agent send`
 * revives the retired chat and starts fresh work — and both cards were anchored
 * to `created_at` and `retired_at`, which happen once per TAB. Measured on the
 * real database: the chat writing this had five user messages against a single
 * pair of timestamps, so four of its five rounds were invisible to the person
 * who asked for them.
 *
 * `ended_at` NULL means the round is running. There is at most one of those per
 * child at a time, which is the invariant every method here is written around —
 * a worker cannot be given a second job while it is mid-turn, because the send
 * queues (AgentQueueStore) and arrives as the NEXT round.
 */
export interface SpawnRound {
  id: string;
  tab_id: string;
  started_at: number;
  /** Null while this round is running. */
  ended_at: number | null;
  report: string | null;
  report_state: string | null;
  artifacts: string[];
  /**
   * When this round's result was put into the PARENT's conversation.
   *
   * Null means "not yet", which is exactly the queue `ReportDelivery` drains —
   * so a round that never had a result to deliver must not sit NULL forever.
   * See `abandon`.
   */
  delivered_at: number | null;
}

interface RawRound {
  id: string;
  tab_id: string;
  started_at: number;
  ended_at: number | null;
  report: string | null;
  report_state: string | null;
  artifacts: string | null;
  delivered_at: number | null;
}

function toRound(r: RawRound): SpawnRound {
  let artifacts: string[] = [];
  try {
    const v = r.artifacts ? JSON.parse(r.artifacts) : [];
    if (Array.isArray(v)) artifacts = v.filter((x): x is string => typeof x === 'string');
  } catch {
    // A malformed value reads as none — it is a link list, and the honest
    // degradation is showing no links.
  }
  return {
    id: r.id,
    tab_id: r.tab_id,
    started_at: r.started_at,
    ended_at: r.ended_at,
    report: r.report,
    report_state: r.report_state,
    artifacts,
    delivered_at: r.delivered_at,
  };
}

const COLUMNS = 'id, tab_id, started_at, ended_at, report, report_state, artifacts, delivered_at';
/**
 * The same list, qualified for the joined queries below.
 *
 * DERIVED, not typed out again. Both parent-scoped queries need `r.`-prefixed
 * columns, and spelling them by hand is how `delivered_at` would reach
 * `toRound` as `undefined` the next time a column is added here — the
 * two-surfaces-one-value defect this corpus keeps paying for.
 */
const R_COLUMNS = COLUMNS.split(', ')
  .map((c) => `r.${c}`)
  .join(', ');

export class SpawnRoundStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * A worker was handed new work. Opens a round unless one is already open.
   *
   * IDEMPOTENT ON AN OPEN ROUND, and that is the whole safety of putting this on
   * `noteUserMessage`: that fires for every message into an agent pane, so a
   * user who sends three lines while the worker is mid-turn must not create
   * three rounds. The second and third are part of the round already running —
   * the queue delivers them to the same turn.
   *
   * Returns the round id when it opened one, null when it did not.
   */
  open(tabId: string, at: number = Date.now()): string | null {
    if (this.openRound(tabId)) return null;
    const id = ulid();
    this.db
      .prepare('INSERT INTO spawn_rounds (id, tab_id, started_at) VALUES (?, ?, ?)')
      .run(id, tabId, at);
    return id;
  }

  /**
   * That round ended. Writes the result onto it and stamps the end.
   *
   * Closes the OPEN round, and does nothing when there is none — a worker whose
   * rounds predate this table finishes turns with nothing to close, and that has
   * to be a no-op rather than an invented round with no beginning.
   */
  close(tabId: string, at: number, write?: SpawnReportWrite | null): boolean {
    const open = this.openRound(tabId);
    if (!open) return false;
    this.db
      .prepare(
        `UPDATE spawn_rounds
            SET ended_at = ?,
                report = COALESCE(?, report),
                report_state = COALESCE(?, report_state),
                artifacts = COALESCE(?, artifacts)
          WHERE id = ?`,
      )
      .run(
        at,
        write?.report ?? null,
        write?.state ?? null,
        // COALESCE throughout so a later write cannot ERASE what an earlier one
        // found. The report lands asynchronously, after the round is closed by
        // the turn-end — see `writeResult`.
        write?.artifacts?.length ? JSON.stringify(write.artifacts) : null,
        open.id,
      );
    return true;
  }

  /**
   * UNDO THE MOST RECENT CLOSE — the job was not over after all.
   *
   * The counterpart to `reviveChat`, and it has to exist for the same reason:
   * retiring a worker mid-job and closing its round are one mistake, so undoing
   * one without the other leaves a worse state than either. With the round shut
   * and none open, the work it went on to do belonged to NOTHING — `close` had
   * nothing to close, and `writeResult` (which finds the most recently ENDED
   * round) attached the new summary to the round that had already reported,
   * overwriting the card that was there and drawing no new one. The second half
   * of the job vanished into the first.
   *
   * REOPENS RATHER THAN OPENING A NEW ONE, because it was one job. The user
   * asked for it once; a log that grows a second pair of cards because the
   * server changed its mind about when the work ended is reporting on our
   * bookkeeping, not on their worker. A genuinely NEW job still opens a new
   * round — that arrives as a user message, through `open` (TabActivity).
   *
   * The premature REPORT goes with it: it was generated over an unfinished
   * transcript, and the real one lands at the real end. The ARTIFACTS stay —
   * they are a regex over work that actually happened, and a published url does
   * not stop existing because the job turned out to have more in it.
   *
   * Does nothing when a round is already open (there is no mistake to undo) or
   * when this child has never had one.
   */
  reopen(tabId: string): boolean {
    if (this.openRound(tabId)) return false;
    const last = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM spawn_rounds
          WHERE tab_id = ? AND ended_at IS NOT NULL
          ORDER BY ended_at DESC, started_at DESC LIMIT 1`,
      )
      .get(tabId) as RawRound | undefined;
    if (!last) return false;
    this.db
      .prepare(
        `UPDATE spawn_rounds SET ended_at = NULL, report = NULL, report_state = NULL,
            delivered_at = NULL WHERE id = ?`,
      )
      .run(last.id);
    return true;
  }

  /**
   * Attach a result to a captured closure (or the latest for synchronous callers).
   *
   * The report is generated by a model call that takes up to thirty seconds, and
   * the round is closed synchronously at turn-end — so by the time there are
   * sentences to write, the round they describe is already closed. This is how
   * they find each other again: async callers pass the captured id and end stamp.
   * A reopened or reclosed round rejects the stale write. `close` does not wait: retirement
   * must never sit behind a model.
   */
  writeResult(tabId: string, write: SpawnReportWrite, closure?: SpawnRound): boolean {
    const last = closure ?? this.lastEnded(tabId);
    if (!last) return false;
    const result = this.db
      .prepare(
        `UPDATE spawn_rounds SET report = ?, report_state = ?,
            artifacts = COALESCE(?, artifacts) WHERE id = ? AND tab_id = ? AND ended_at = ?`,
      )
      .run(
        write.report,
        write.state,
        write.artifacts?.length ? JSON.stringify(write.artifacts) : null,
        last.id,
        tabId,
        last.ended_at,
      );
    return result.changes > 0;
  }

  /**
   * The round that ended MOST RECENTLY, or null.
   *
   * The one a result belongs to: rounds are closed synchronously at the end of
   * the work and the summary arrives up to thirty seconds later, so "the round
   * being reported on" is always a closed one. Shared by `writeResult`, which
   * attaches the sentences, and by the report gate, which needs the round's
   * START to tell a new job from a retry.
   */
  lastEnded(tabId: string): SpawnRound | null {
    const r = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM spawn_rounds
          WHERE tab_id = ? AND ended_at IS NOT NULL
          ORDER BY ended_at DESC, started_at DESC LIMIT 1`,
      )
      .get(tabId) as RawRound | undefined;
    return r ? toRound(r) : null;
  }

  /** The round currently running for this child, or null. */
  openRound(tabId: string): SpawnRound | null {
    const r = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM spawn_rounds
          WHERE tab_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      )
      .get(tabId) as RawRound | undefined;
    return r ? toRound(r) : null;
  }

  /** Every round this child has had, oldest first. */
  listByTab(tabId: string): SpawnRound[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM spawn_rounds WHERE tab_id = ? ORDER BY started_at ASC`)
      .all(tabId) as RawRound[];
    return rows.map(toRound);
  }

  /**
   * Rounds of `parentTabId`'s children whose RESULT IS WAITING to be delivered.
   *
   * Finished (`ended_at`), carrying something to say, and never delivered. The
   * "something to say" clause is `report IS NOT NULL OR report_state IS NOT
   * NULL` and it is what keeps the queue honest: a round can close with neither
   * — a worker whose summary is still being generated, one whose generation
   * failed outright — and delivering a nameless empty section to the parent
   * would be noise with a marker on it. Such a round stays NULL here and is
   * picked up when its result lands (or abandoned by the caller).
   *
   * Oldest first, because that is the order the parent's message lists them in
   * and the order a reader expects a batch to have happened in.
   */
  undeliveredByParent(parentTabId: string): SpawnRound[] {
    const rows = this.db
      .prepare(
        `SELECT ${R_COLUMNS}
           FROM spawn_rounds r JOIN tabs t ON t.id = r.tab_id
          WHERE t.spawned_by = ?
            -- A tab that is its own parent would be handed its own report,
            -- which opens a round, which reports, which is handed back: a
            -- genuine infinite loop rather than a cosmetic oddity. spawned_by
            -- is not a foreign key and nothing constrains it, so the guard is
            -- here rather than assumed.
            AND t.id <> t.spawned_by
            AND r.ended_at IS NOT NULL
            AND r.delivered_at IS NULL
            AND (r.report IS NOT NULL OR r.report_state IS NOT NULL)
          ORDER BY r.ended_at ASC, r.started_at ASC`,
      )
      .all(parentTabId) as RawRound[];
    return rows.map(toRound);
  }

  /**
   * How many of `parentTabId`'s children are STILL MID-ROUND.
   *
   * The batch barrier: while this is above zero the fan-out has not landed, so
   * a sibling that just finished waits rather than sending a message of its
   * own. An open round is the right signal and a pane's `status` is not — the
   * round spans the whole job (a worker pausing between two turns is not
   * finished), which is the distinction `JOB_SETTLE_MS` exists to draw.
   *
   * NOT A LIVENESS CHECK, and the caller must not treat it as one: a worker
   * whose runner died mid-round leaves its round open forever, so a barrier
   * built on this alone would hold its siblings' reports for good. The hold is
   * bounded in time for exactly that case — see `BATCH_MAX_HOLD_MS`.
   */
  openRoundCountByParent(parentTabId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM spawn_rounds r JOIN tabs t ON t.id = r.tab_id
            WHERE t.spawned_by = ? AND t.id <> t.spawned_by AND r.ended_at IS NULL`,
        )
        .get(parentTabId) as { n: number }
    ).n;
  }

  /**
   * Stamp these rounds delivered. Returns how many rows moved.
   *
   * Scoped to rows that are still NULL so a double call cannot re-stamp (and
   * cannot report a second success for the same work). The caller stamps BEFORE
   * it sends and reverts on refusal — see `undeliver` — because of the two ways
   * a non-transactional send can go wrong, delivering a batch twice is much the
   * worse one.
   */
  markDelivered(ids: readonly string[], at: number): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      'UPDATE spawn_rounds SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
    );
    return this.db.transaction(() => {
      let n = 0;
      for (const id of ids) n += stmt.run(at, id).changes;
      return n;
    })();
  }

  /**
   * Undo `markDelivered` — the send was refused, so it never arrived.
   *
   * SCOPED TO THE STAMP IT IS UNDOING (`at`), not a blanket clear by id. A bare
   * `delivered_at = NULL WHERE id = ?` would resurrect a round that had been
   * delivered for real at some earlier moment, re-sending a result the parent
   * already acted on — the one failure this feature must not have. Matching the
   * stamp makes the call an exact inverse of the write that preceded it, so it
   * can only ever undo its own work.
   */
  undeliver(ids: readonly string[], at: number): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      'UPDATE spawn_rounds SET delivered_at = NULL WHERE id = ? AND delivered_at = ?',
    );
    return this.db.transaction(() => {
      let n = 0;
      for (const id of ids) n += stmt.run(id, at).changes;
      return n;
    })();
  }

  /**
   * Every round of every child of `parentTabId`, keyed by child.
   *
   * ONE query for a whole conversation rather than one per card: a parent with
   * thirty children is the case this exists for, and thirty round-trips to draw
   * one log is the shape of problem the corpus already solved once.
   */
  listByParent(parentTabId: string): Map<string, SpawnRound[]> {
    const rows = this.db
      .prepare(
        `SELECT ${R_COLUMNS}
           FROM spawn_rounds r JOIN tabs t ON t.id = r.tab_id
          WHERE t.spawned_by = ?
          ORDER BY r.started_at ASC`,
      )
      .all(parentTabId) as RawRound[];
    const out = new Map<string, SpawnRound[]>();
    for (const raw of rows) {
      const list = out.get(raw.tab_id) ?? [];
      list.push(toRound(raw));
      out.set(raw.tab_id, list);
    }
    return out;
  }
}
