import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import { decorateTab } from '../ptyd-cache.js';
import type { PtydCache } from '../ptyd-cache.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { glossaryCache } from './glossary.js';
import { type HeadlineModel, agentSdkHeadlineModel, maybeWriteHeadline } from './headline.js';

/**
 * Keeps the nav rail's second line current, and nothing else.
 *
 * Subscribes to turn-end on the shared event bus — the same trigger the
 * archiver uses — and hands each finished turn to the rate-limited generator
 * in headline.ts. The generator, not this class, owns every decision about
 * WHETHER to spend a model call; this is the plumbing.
 *
 * Two deliberate properties:
 *
 *  - ONE in-flight generation per tab. The bus is synchronous and a busy
 *    agent can finish turns faster than a model call returns, so without this
 *    a chat could stack up calls that all summarise almost the same thing and
 *    then race to write. The in-flight set is the cheap fix; the interval gate
 *    in headline.ts is the real one.
 *  - Fire-and-forget, and it never throws. A failed summary must not affect a
 *    turn's completion, its archive, or its push notification — the rail's
 *    second line is the least important thing on the screen, and it should
 *    behave like it.
 *
 * Emits `tab.updated` on a successful write so the sidebar picks the line up
 * live rather than on its next 5s poll. Nothing is emitted for a KEEP, which
 * is the common case — a no-op turn costs the client nothing.
 */
export class HeadlineWriter {
  private readonly db: Database.Database;
  private readonly events: EventBus;
  private readonly cache: PtydCache;
  private readonly model: HeadlineModel;
  private readonly glossary: () => readonly string[];
  private unsubscribe?: () => void;
  private readonly inFlight = new Set<string>();
  /** Tests await this to let a triggered generation settle. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    db: Database.Database;
    events: EventBus;
    cache: PtydCache;
    /** Where this install's published artifacts live — the one thing the
     *  glossary needs beyond the db. */
    dataDir?: string;
    /** Test seam. Defaults to the Agent SDK haiku one-shot. */
    model?: HeadlineModel;
  }) {
    this.db = opts.db;
    this.events = opts.events;
    this.cache = opts.cache;
    this.model = opts.model ?? agentSdkHeadlineModel;
    // Same builder, and same time-cache, as the dictation cleanup pass: the
    // model labelling a chat needs to know "muxpad" and "ptyd" for exactly the
    // reason the model repairing dictation does, and maintaining a second list
    // would guarantee the two drift. Cached because a generation is
    // rate-limited but a boot with forty tabs is not.
    const dataDir = opts.dataDir;
    this.glossary = dataDir ? glossaryCache(opts.db, dataDir) : () => [];
  }

  start(): void {
    this.unsubscribe = this.events.subscribe((e) => {
      // `done` only, not `fatal`. The archiver takes both because a crashed
      // runner has usually just written the most interesting part of the
      // transcript; a headline has the opposite priority — summarising a
      // half-finished turn produces a line about work that didn't happen.
      if (e.type !== 'agent_turn' || e.phase !== 'done') return;
      this.schedule(e.pane_id);
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** In-flight work settles (tests await this between assertions). */
  async idle(): Promise<void> {
    await this.pending;
  }

  private schedule(paneId: string): void {
    const panes = new PaneStore(this.db);
    const pane = panes.getById(paneId);
    if (!pane) return;
    const tabId = pane.tab_id;
    if (this.inFlight.has(tabId)) return;
    this.inFlight.add(tabId);
    const run = maybeWriteHeadline(this.db, tabId, paneId, this.model, {
      glossary: this.glossary(),
    })
      .then((headline) => {
        if (!headline) return;
        const tab = new TabStore(this.db).getById(tabId);
        if (!tab) return;
        this.events.emit({
          type: 'tab.updated',
          tab: decorateTab(this.cache, this.db, tab),
        });
      })
      .catch((err) => {
        // Logged, never surfaced. See the class note.
        console.error('[headline] generation failed', err);
      })
      .finally(() => {
        this.inFlight.delete(tabId);
      });
    this.pending = this.pending.then(() => run);
  }
}
