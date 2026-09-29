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
}

interface RawRound {
  id: string;
  tab_id: string;
  started_at: number;
  ended_at: number | null;
  report: string | null;
  report_state: string | null;
  artifacts: string | null;
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
  };
}

const COLUMNS = 'id, tab_id, started_at, ended_at, report, report_state, artifacts';

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
        'UPDATE spawn_rounds SET ended_at = NULL, report = NULL, report_state = NULL WHERE id = ?',
      )
      .run(last.id);
    return true;
  }

  /**
   * Attach a result to the round that ended MOST RECENTLY.
   *
   * The report is generated by a model call that takes up to thirty seconds, and
   * the round is closed synchronously at turn-end — so by the time there are
   * sentences to write, the round they describe is already closed. This is how
   * they find each other again, and it is why `close` does not wait: retirement
   * must never sit behind a model.
   */
  writeResult(tabId: string, write: SpawnReportWrite): boolean {
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
        `UPDATE spawn_rounds SET report = ?, report_state = ?,
            artifacts = COALESCE(?, artifacts) WHERE id = ?`,
      )
      .run(
        write.report,
        write.state,
        write.artifacts?.length ? JSON.stringify(write.artifacts) : null,
        last.id,
      );
    return true;
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
   * Every round of every child of `parentTabId`, keyed by child.
   *
   * ONE query for a whole conversation rather than one per card: a parent with
   * thirty children is the case this exists for, and thirty round-trips to draw
   * one log is the shape of problem the corpus already solved once.
   */
  listByParent(parentTabId: string): Map<string, SpawnRound[]> {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.tab_id, r.started_at, r.ended_at, r.report, r.report_state, r.artifacts
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
