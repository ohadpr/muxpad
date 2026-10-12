import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import { decorateTab } from '../ptyd-cache.js';
import type { PtydCache } from '../ptyd-cache.js';
import { PaneStore } from '../store/PaneStore.js';
import { type SpawnRound, SpawnRoundStore } from '../store/SpawnRoundStore.js';
import { type SpawnReportWrite, TabStore } from '../store/TabStore.js';
import { clockIndex, isSubChat } from '../tab-clock.js';
import { glossaryCache } from './glossary.js';
import {
  type SpawnReportModel,
  agentSdkSpawnReportModel,
  maybeWriteSpawnReport,
} from './spawn-report.js';
import { type SpawnTaskModel, maybeWriteSpawnTask } from './spawn-task.js';

/**
 * How many already-retired children a boot will retry a summary for. Small on
 * purpose — see {@link SpawnReportWriter.recoverStuck}. Every one is a model
 * call, and they are the tail of a list nobody is waiting on.
 */
export const RECOVER_LIMIT = 8;

/**
 * Turns "a worker finished" into a report in its parent's log, and nothing else.
 *
 * HeadlineWriter's skeleton, deliberately: this is the same arrangement — a
 * synchronous signal, a rate-limited generator that owns every decision about
 * whether to spend a model call, one in-flight per tab, `tab.updated` on write —
 * and the differences are only in what it subscribes to.
 *
 * ─── IT DOES NOT SUBSCRIBE TO THE BUS ─────────────────────────────────────────
 * Unlike HeadlineWriter, which watches `agent_turn` itself. The question "has
 * this WORKER finished" is already answered, carefully, by ChatRetirer — cron's
 * keep-list, split into "still working" and "finished but keep the row" (see
 * tab-retire.ts). A second subscriber re-deriving that from the raw turn event
 * would be a second opinion about the one thing that must not drift: whether a
 * blocked agent, a live subagent roster or a queued message means "done".
 *
 * So `onFinished` on ChatRetirer is the seam, and it is called for a crashed
 * worker and an artifact-holding one too — both of which keep their live rows
 * and would be invisible to a retirement-triggered writer.
 *
 * ─── RETIREMENT NEVER WAITS FOR THIS ──────────────────────────────────────────
 * `onFinished` is called from a synchronous bus handler and this returns
 * immediately. The row leaves the live list on the same tick it always did; the
 * report lands when it lands, up to 30 seconds later. A model call must never
 * sit in front of a turn's completion, its archive or its push.
 *
 * Fire-and-forget and it never throws: a failed report must not affect a turn.
 */
export class SpawnReportWriter {
  private readonly db: Database.Database;
  private readonly events: EventBus;
  private readonly cache: PtydCache;
  private readonly model: SpawnReportModel;
  private readonly onReport: ((tabId: string) => void) | undefined;
  private readonly taskModel: SpawnTaskModel;
  private readonly glossary: () => readonly string[];
  private readonly inFlight = new Set<string>();
  private closureAt = 0;
  /** Tabs whose task label has been ATTEMPTED this process — see `start`. */
  private readonly taskTried = new Set<string>();
  /**
   * Tabs whose report has already been RETRIED this process.
   *
   * One retry, ever, per worker per boot. The gate in spawn-report.ts assumes
   * another turn-end will come along to try again on; a RETIRED worker never
   * finishes another turn, so without this a transient failure was permanent —
   * three of six children in one afternoon, each with the attempt stamped and no
   * state at all. In memory rather than a column because what it bounds is a
   * BROKEN INSTALL spinning, and a restart is a fine moment to try once more.
   */
  private readonly retried = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  /** Tests await this to let a triggered generation settle. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    db: Database.Database;
    events: EventBus;
    cache: PtydCache;
    /** Where this install's published artifacts live — the glossary's one need
     *  beyond the db. Omitted (tests) means no vocabulary section. */
    dataDir?: string;
    /** Test seam. Defaults to the Agent SDK haiku one-shot. */
    model?: SpawnReportModel;
    /** Test seam for the task label — the same bare one-shot by default. */
    taskModel?: SpawnTaskModel;
    /**
     * A child's result is FINAL — deliver it to the parent (ReportDelivery).
     *
     * Hung off `deliver` rather than off `onFinished`, because `onFinished`
     * fires before the report exists: the summary is a model call up to thirty
     * seconds behind it, and a delivery triggered there would hand the parent
     * an empty section. `deliver` is the one funnel both the turn-end path and
     * the boot sweep pass through, so wiring it here covers both.
     *
     * Must never throw — see the class note.
     */
    onReport?: (tabId: string) => void;
  }) {
    this.db = opts.db;
    this.events = opts.events;
    this.cache = opts.cache;
    this.model = opts.model ?? agentSdkSpawnReportModel;
    this.onReport = opts.onReport;
    this.taskModel = opts.taskModel ?? opts.model ?? agentSdkSpawnReportModel;
    // The SAME vocabulary the headline generator
    // use, for a sharper version of the same reason: a cheap model summarising
    // work on "ptyd" is exactly the model that stops reporting and starts asking
    // what ptyd is. Cached, because a report is rate-limited but a boot is not.
    const dataDir = opts.dataDir;
    this.glossary = dataDir ? glossaryCache(opts.db, dataDir) : () => [];
  }

  /**
   * Subscribe for the TASK half — the label on a worker's card, generated from
   * its first message.
   *
   * This one DOES watch the bus, and the asymmetry is the point. "Has this
   * worker finished" is a careful judgement that belongs to ChatRetirer and must
   * not be re-derived (see the class note); "a turn happened in a sub-chat" is a
   * raw fact with nothing to get wrong, and the label has to land at the START
   * of the work rather than the end — a card that is unreadable until the job is
   * over is the card being replaced.
   *
   * Bounded by ONE ATTEMPT PER TAB PER PROCESS rather than by a persisted clock.
   * The column is write-once, so a label that lands is never asked for again;
   * what this guards is the child whose label cannot be produced, and for that
   * "once per boot" is the right ceiling and needs no column.
   */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.events.subscribe((e) => {
      if (e.type !== 'agent_turn') return;
      this.scheduleTask(e.pane_id);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private scheduleTask(paneId: string): void {
    const pane = new PaneStore(this.db).getById(paneId);
    if (!pane) return;
    // ONLY sub-chats. A top-level chat is a conversation, not a task, and it has
    // no card in anyone's log to label.
    if (!isSubChat(clockIndex(this.db), pane.tab_id)) return;
    const tabId = pane.tab_id;
    if (this.taskTried.has(tabId)) return;
    const tab = new TabStore(this.db).getById(tabId);
    if (!tab || tab.spawn_task) return;
    this.taskTried.add(tabId);
    const run = maybeWriteSpawnTask(this.db, tabId, paneId, this.taskModel)
      .then((task) => {
        // Nothing written reaches nobody — the common case is a first turn whose
        // message has not hit the transcript yet.
        if (!task) {
          // …and THAT case is worth another go: the label is the card's whole
          // content, and the next turn is seconds away.
          this.taskTried.delete(tabId);
          return;
        }
        const fresh = new TabStore(this.db).getById(tabId);
        if (!fresh) return;
        this.events.emit({
          type: 'tab.updated',
          tab: decorateTab(this.cache, this.db, fresh),
        });
      })
      .catch((err) => {
        console.error('[spawn-task] generation failed', err);
      });
    this.pending = this.pending.then(() => run);
  }

  /** In-flight work settles (tests await this between assertions). */
  async idle(): Promise<void> {
    await this.pending;
  }

  /**
   * A sub-chat's work has ended. Wire this to `ChatRetirer`'s `onFinished`.
   *
   * ONE in-flight generation per closure: a crash loop, or a worker revived and
   * finished twice inside a second, would otherwise stack calls that summarise
   * nearly the same transcript and then race to write. A reopened round gets
   * its own generation; the old one cannot block or overwrite it. The interval gate in
   * spawn-report.ts is the real limiter; this is the cheap one.
   */
  onFinished = (
    tabId: string,
    paneId: string,
    opts: { crashed: boolean; awaiting: boolean },
  ): void => {
    // CLOSE THE ROUND FIRST, synchronously. A worker is handed successive jobs,
    // and each one is a round with its own pair of cards; the round ends when
    // the turn does, and that must not sit behind a model call the way the
    // sentences below do. See store/SpawnRoundStore.
    //
    // A no-op for a child whose rounds predate the table — it finishes turns
    // with nothing open, and an invented round with no beginning would be worse
    // than none.
    const rounds = new SpawnRoundStore(this.db);
    // Distinct closure generations even when a resume and finish share a tick.
    this.closureAt = Math.max(Date.now(), this.closureAt + 1);
    rounds.close(tabId, this.closureAt);
    const round = rounds.lastEnded(tabId);
    const key = `${tabId}:${round?.id}:${round?.ended_at}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const current = () => this.isCurrent(tabId, round);
    const attempt = (force: boolean) =>
      maybeWriteSpawnReport(this.db, tabId, paneId, this.model, {
        crashed: opts.crashed,
        awaiting: opts.awaiting,
        glossary: this.glossary(),
        force,
        current,
        writeTab: () => this.ownsTab(tabId, round),
      });
    const run = attempt(false)
      .then(async (first) => {
        // RETRY ONCE on a generation that produced nothing. `force` is what gets
        // past the interval the failed attempt just charged — see the option's
        // note for why a retired worker has no other way back here.
        //
        // Only when the row still has NO state: `none` is an answer, `crashed`
        // and `awaiting` are facts we observed, and re-asking any of them would
        // spend a second call to be told the same thing.
        //
        // `failed` COUNTS AS NOTHING HERE. It is a write, so it is truthy, and
        // reading it as success would have quietly undone this retry the moment
        // the failure paths started recording themselves — the state exists to
        // describe a lost generation to the user, not to settle it.
        if (!current()) return null;
        if (first && first.state !== 'failed') return first;
        if (this.retried.has(tabId)) return first;
        const row = new TabStore(this.db).getById(tabId);
        if (!row || (row.spawn_report_state && row.spawn_report_state !== 'failed')) return first;
        this.retried.add(tabId);
        return (await attempt(true)) ?? first;
      })
      .then((write) => {
        this.deliver(tabId, write, round);
      })
      .catch((err) => {
        // Logged, never surfaced. See the class note.
        console.error('[spawn-report] generation failed', err);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.pending = this.pending.then(() => run);
  };

  /**
   * One result, to the round and to every connected client. Shared by the
   * turn-end path and the boot sweep so the two cannot deliver differently.
   */
  private isCurrent(tabId: string, round: SpawnRound | null): boolean {
    const rounds = new SpawnRoundStore(this.db);
    if (!round) return !rounds.openRound(tabId) && !rounds.lastEnded(tabId);
    const fresh = rounds.listByTab(tabId).find((r) => r.id === round.id);
    return fresh?.ended_at === round.ended_at;
  }

  private ownsTab(tabId: string, round: SpawnRound | null): boolean {
    const rounds = new SpawnRoundStore(this.db);
    return !rounds.openRound(tabId) && rounds.lastEnded(tabId)?.id === round?.id;
  }

  private deliver(tabId: string, write: SpawnReportWrite | null, round: SpawnRound | null): void {
    // Reopening invalidates the captured closure. A NEW job does not: keep
    // the historical result, but only the newest closed job may write the tab.
    if (!this.isCurrent(tabId, round)) return;
    if (write && round) new SpawnRoundStore(this.db).writeResult(tabId, write, round);
    // Nothing written is the common case — inside the interval, a worker with
    // no transcript — and it must reach nobody: an event per no-op is a repaint
    // per no-op on every connected client.
    if (!write) return;
    const tab = new TabStore(this.db).getById(tabId);
    if (!tab) return;
    // The parent's conversation is watching the CHILD's row (the spawn cards
    // derive from the tab corpus), so this one event is the whole delivery
    // path: `tab.updated` → web/src/tabs.ts `applyTabRow` → the corpus → the
    // card. No new protocol, and it reaches every connected device.
    this.events.emit({
      type: 'tab.updated',
      tab: decorateTab(this.cache, this.db, tab),
    });
    // AFTER the row is written and the clients know. The delivery reads the
    // round back out of the database (it does not take the text from here), so
    // the write above is its input — and a parent that starts a turn before its
    // own sidebar has the child's card would be reacting to something the user
    // cannot yet see.
    try {
      this.onReport?.(tabId);
    } catch (err) {
      // A report that landed is worth more than its delivery. The sweep retries.
      console.error('[spawn-report] delivery hand-off failed', err);
    }
  }

  /**
   * RETRY THE WORKERS THAT ALREADY RETIRED WITHOUT A SUMMARY. Call once at boot.
   *
   * The in-process retry above only ever runs inside `onFinished`, and
   * `onFinished` comes from a turn ending. A worker that retired in a PREVIOUS
   * process with its attempt stamped and nothing to show for it is therefore
   * unreachable by it — no turn of its will ever end again. The retry's own note
   * says "a restart is a fine moment to try once more", and it was the only part
   * of that sentence nothing implemented: measured on the live database, four
   * children sat permanently empty this way, three of them retired within the
   * same half hour.
   *
   * Their transcripts are still on disk, which is the whole reason this can
   * work: the generator reads the tail of the conversation, not anything the
   * finished process held in memory.
   *
   * BOUNDED THREE WAYS, because a boot must not turn into a model-call storm:
   * the most recent {@link RECOVER_LIMIT} candidates only, one attempt each
   * (`retried`, shared with the turn-end path), and serialised behind the same
   * `pending` chain as everything else. A worker nobody has looked at in weeks
   * is not worth a call at every restart.
   */
  recoverStuck(limit = RECOVER_LIMIT): void {
    // `spawn_report_at IS NOT NULL` is the load-bearing clause: it means we
    // ATTEMPTED and lost it. Without it this would sweep up children that
    // retired before the feature existed and re-summarise the archive.
    const rows = this.db
      .prepare(
        `SELECT t.id AS tab_id, MIN(p.id) AS pane_id
           FROM tabs t JOIN panes p ON p.tab_id = t.id
          WHERE t.spawned_by IS NOT NULL
            AND t.retired_at IS NOT NULL
            AND t.spawn_report IS NULL
            AND t.spawn_report_at IS NOT NULL
            AND (t.spawn_report_state IS NULL OR t.spawn_report_state = 'failed')
          GROUP BY t.id
          ORDER BY t.retired_at DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{ tab_id: string; pane_id: string }>;
    if (rows.length === 0) return;
    console.log(`[spawn-report] boot sweep: retrying ${rows.length} worker(s) with no summary`);
    for (const { tab_id: tabId, pane_id: paneId } of rows) {
      if (this.retried.has(tabId)) continue;
      this.retried.add(tabId);
      // `force`, for the same reason the turn-end retry needs it: the failed
      // attempt already charged the interval, and the gate would refuse.
      //
      // crashed/awaiting are NOT re-asserted here. They are facts about a turn
      // this process never saw, and a row that carries either one is excluded by
      // the query anyway — only a NULL or `failed` state gets this far.
      const round = new SpawnRoundStore(this.db).lastEnded(tabId);
      const run = maybeWriteSpawnReport(this.db, tabId, paneId, this.model, {
        crashed: false,
        awaiting: false,
        glossary: this.glossary(),
        force: true,
        current: () => this.isCurrent(tabId, round),
        writeTab: () => this.ownsTab(tabId, round),
      })
        .then((write) => {
          this.deliver(tabId, write, round);
        })
        .catch((err) => {
          console.error(`[spawn-report] boot sweep failed for tab ${tabId}`, err);
        });
      this.pending = this.pending.then(() => run);
    }
  }
}
