import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import { decorateTab } from '../ptyd-cache.js';
import type { PtydCache } from '../ptyd-cache.js';
import { TabStore } from '../store/TabStore.js';
import { glossaryCache } from './glossary.js';
import {
  type SpawnReportModel,
  agentSdkSpawnReportModel,
  maybeWriteSpawnReport,
} from './spawn-report.js';

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
  private readonly glossary: () => readonly string[];
  private readonly inFlight = new Set<string>();
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
  }) {
    this.db = opts.db;
    this.events = opts.events;
    this.cache = opts.cache;
    this.model = opts.model ?? agentSdkSpawnReportModel;
    // The SAME vocabulary the headline generator and the dictation cleanup pass
    // use, for a sharper version of the same reason: a cheap model summarising
    // work on "ptyd" is exactly the model that stops reporting and starts asking
    // what ptyd is. Cached, because a report is rate-limited but a boot is not.
    const dataDir = opts.dataDir;
    this.glossary = dataDir ? glossaryCache(opts.db, dataDir) : () => [];
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
  onFinished = (tabId: string, paneId: string, opts: { crashed: boolean }): void => {
    if (this.inFlight.has(tabId)) return;
    this.inFlight.add(tabId);
    const run = maybeWriteSpawnReport(this.db, tabId, paneId, this.model, {
      crashed: opts.crashed,
      glossary: this.glossary(),
    })
      .then((write) => {
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
