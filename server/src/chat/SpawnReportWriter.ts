import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import { decorateTab } from '../ptyd-cache.js';
import type { PtydCache } from '../ptyd-cache.js';
import { PaneStore } from '../store/PaneStore.js';
import { SpawnRoundStore } from '../store/SpawnRoundStore.js';
import { TabStore } from '../store/TabStore.js';
import { clockIndex, isSubChat } from '../tab-clock.js';
import { glossaryCache } from './glossary.js';
import {
  type SpawnReportModel,
  agentSdkSpawnReportModel,
  maybeWriteSpawnReport,
} from './spawn-report.js';
import { type SpawnTaskModel, maybeWriteSpawnTask } from './spawn-task.js';

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
  private readonly taskModel: SpawnTaskModel;
  private readonly glossary: () => readonly string[];
  private readonly inFlight = new Set<string>();
  /** Tabs whose task label has been ATTEMPTED this process — see `start`. */
  private readonly taskTried = new Set<string>();
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
  }) {
    this.db = opts.db;
    this.events = opts.events;
    this.cache = opts.cache;
    this.model = opts.model ?? agentSdkSpawnReportModel;
    this.taskModel = opts.taskModel ?? opts.model ?? agentSdkSpawnReportModel;
    // The SAME vocabulary the headline generator and the dictation cleanup pass
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
   * ONE in-flight generation per tab: a crash loop, or a worker revived and
   * finished twice inside a second, would otherwise stack calls that summarise
   * nearly the same transcript and then race to write. The interval gate in
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
    new SpawnRoundStore(this.db).close(tabId, Date.now());
    if (this.inFlight.has(tabId)) return;
    this.inFlight.add(tabId);
    const run = maybeWriteSpawnReport(this.db, tabId, paneId, this.model, {
      crashed: opts.crashed,
      awaiting: opts.awaiting,
      glossary: this.glossary(),
    })
      .then((write) => {
        // The sentences arrive up to thirty seconds after the round closed, so
        // they are attached to the round that ENDED rather than to whatever is
        // open now — a worker re-tasked in the meantime must not have the
        // previous round's result land on its new one.
        if (write) new SpawnRoundStore(this.db).writeResult(tabId, write);
        // Nothing written is the common case — inside the interval, a rejected
        // reply, a worker with no transcript — and it must reach nobody: an
        // event per no-op is a repaint per no-op on every connected client.
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
      })
      .catch((err) => {
        // Logged, never surfaced. See the class note.
        console.error('[spawn-report] generation failed', err);
      })
      .finally(() => {
        this.inFlight.delete(tabId);
      });
    this.pending = this.pending.then(() => run);
  };
}
