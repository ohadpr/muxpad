import { type SpawnDeliveryEntry, renderSpawnDelivery } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { PaneStore } from '../store/PaneStore.js';
import { type SpawnRound, SpawnRoundStore } from '../store/SpawnRoundStore.js';
import { TabStore } from '../store/TabStore.js';

/**
 * THE JOIN — a finished child's result, into its parent's conversation.
 *
 * See `@muxpad/shared` spawn-delivery.ts for why this exists at all. This half
 * owns the two questions that cannot be answered in a renderer: WHEN a batch
 * has landed, and WHETHER there is anybody to tell.
 *
 * ─── IT IS A QUEUE DRAIN, NOT AN EVENT HANDLER ──────────────────────────────
 * `spawn_rounds.delivered_at IS NULL` is the queue; everything here is a drain
 * of it. `onReport` is a NUDGE — "something may be ready now" — and not the
 * delivery mechanism, which matters because the nudge is lossy in both
 * directions: it fires for a child whose siblings are still working (nothing to
 * do yet) and it fails to fire for the last report of a batch held behind a
 * sibling whose runner died (nothing will ever nudge again). A sweep covers
 * both, and the durable column means a restart mid-batch resumes rather than
 * forgetting. The alternative — in-memory pending state — loses a fan-out to
 * every server bounce, and this install bounces.
 *
 * ─── EVERY EXIT MARKS THE ROUND ─────────────────────────────────────────────
 * A round that will never be delivered must not stay NULL, or the queue grows
 * forever and the sweep re-examines it until the database is deleted. So the
 * abandon paths (no parent, parent archived, parent is not an agent) stamp the
 * row too. `delivered_at` means "this round's result is settled with respect to
 * its parent", which includes "there was nobody to give it to".
 */

/**
 * HOW LONG A FINISHED CHILD'S REPORT WAITS for its siblings.
 *
 * The batch barrier is `openRoundCountByParent`, and that count is not a
 * liveness check: a worker whose runner died mid-round leaves its round open
 * forever, so an unbounded barrier would hold its siblings' reports for good —
 * turning the feature into a strictly worse version of the silence it replaces.
 *
 * So the hold has a ceiling. Past it the batch goes out incomplete, and the
 * straggler is delivered on its own when (if) it ever lands. Ten minutes is
 * sized off what it is waiting for: the spread between the first and last
 * worker of a fan-out, where the workers are minutes-long agent jobs. Shorter
 * and a normal 20-way fan-out would split into several messages for no reason;
 * much longer and a wedged worker costs the orchestrator its whole batch.
 */
export const BATCH_MAX_HOLD_MS = 10 * 60_000;

/** How often the sweep looks for a hold that has run out of patience. */
export const DELIVERY_SWEEP_MS = 60_000;

export interface SubmitSendResult {
  status: 'sent' | 'queued' | 'rejected';
  reason?: string | undefined;
}

export interface ReportDeliveryDeps {
  db: Database.Database;
  /**
   * The ONE injection primitive — ws.ts `submitSend`. Synchronous, and this
   * file depends on that: see `flushParent` for why the read-decide-stamp-send
   * sequence must not be interleaved with another flush of the same parent.
   */
  submitSend: (paneId: string, text: string) => SubmitSendResult;
  now?: () => number;
}

interface Flushed {
  /** Children whose results went out. */
  delivered: number;
  /** Rounds settled with nobody to tell. */
  abandoned: number;
  /** Rounds still held for a sibling. */
  held: number;
}

/** A fresh zero result. NOT a shared const: it is returned to callers, and one
 *  that accumulated into it would corrupt every later return. */
const nothing = (): Flushed => ({ delivered: 0, abandoned: 0, held: 0 });

export class ReportDelivery {
  private readonly db: Database.Database;
  private readonly submitSend: ReportDeliveryDeps['submitSend'];
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Parents whose refusal we have already reported, this process.
   *
   * A rejection is treated as transient and retried by the sweep, which is
   * right for a full queue — but WRONG to do silently: a runner whose automatic
   * restarts are exhausted refuses permanently, and without this the batch is
   * retried once a minute forever with nothing said anywhere. That is the
   * invisible-failure shape this install has already been bitten by once.
   *
   * Once per parent per process: enough to be findable in the log, quiet enough
   * that a minute-by-minute retry does not become the log.
   */
  private readonly refusalLogged = new Set<string>();

  constructor(deps: ReportDeliveryDeps) {
    this.db = deps.db;
    this.submitSend = deps.submitSend;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * A child's result just became final. Wire to `SpawnReportWriter.deliver`.
   *
   * Takes the CHILD's tab id and resolves the parent itself, so the caller
   * needs to know nothing about the tree. Never throws: it hangs off the tail
   * of a report write, and a failure here must cost the delivery, not the
   * report. (The sweep will try again regardless.)
   */
  onReport = (childTabId: string): void => {
    try {
      const parentId = new TabStore(this.db).clockRow(childTabId)?.spawned_by;
      if (!parentId) return;
      this.flushParent(parentId);
    } catch (err) {
      console.error('[report-delivery] nudge failed', err);
    }
  };

  /**
   * Deliver every batch that is ready, across all parents. Call at boot and on
   * an interval.
   *
   * The boot call is load-bearing: a batch half-delivered when the server went
   * down, or one whose last nudge was lost with the process, is only reachable
   * from here.
   */
  sweep(): Flushed {
    const total = nothing();
    try {
      // Only parents that actually have something pending — this is the whole
      // queue in one query rather than a scan of every tab.
      const parents = this.db
        .prepare(
          `SELECT DISTINCT t.spawned_by AS parent_id
             FROM spawn_rounds r JOIN tabs t ON t.id = r.tab_id
            WHERE t.spawned_by IS NOT NULL
              AND t.id <> t.spawned_by
              AND r.ended_at IS NOT NULL
              AND r.delivered_at IS NULL
              AND (r.report IS NOT NULL OR r.report_state IS NOT NULL)`,
        )
        .all() as Array<{ parent_id: string }>;
      for (const { parent_id: parentId } of parents) {
        const r = this.flushParent(parentId);
        total.delivered += r.delivered;
        total.abandoned += r.abandoned;
        total.held += r.held;
      }
    } catch (err) {
      console.error('[report-delivery] sweep failed', err);
    }
    return total;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), DELIVERY_SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One parent's pending batch: decide, render, send, stamp.
   *
   * SYNCHRONOUS FROM READ TO STAMP, deliberately. Two flushes of the same
   * parent interleaving would both read the same undelivered rows and both send
   * them, and the only thing standing between this code and that is that
   * nothing here awaits — Node's single thread does the mutual exclusion a lock
   * would otherwise have to. `submitSend` is synchronous for the same reason.
   * If this ever needs to await, it needs a per-parent guard first.
   */
  private flushParent(parentTabId: string): Flushed {
    const rounds = new SpawnRoundStore(this.db);
    const pending = rounds.undeliveredByParent(parentTabId);
    if (pending.length === 0) return nothing();

    // ─── IS THERE ANYBODY TO TELL? ──────────────────────────────────────────
    // Each of these settles the rounds rather than skipping them: see the class
    // note on why an un-deliverable round must not stay in the queue.
    const tabs = new TabStore(this.db);
    const parent = tabs.clockRow(parentTabId);
    if (!parent) return this.abandon(rounds, pending, 'parent tab is gone');
    // ─── ONLY THE USER'S OWN HAND STOPS A DELIVERY ──────────────────────────
    // The test is `archived`, NOT "has left the live list", and the difference
    // is the feature working for nested fan-outs or silently dropping them.
    //
    // A worker that spawns its own workers ends its turn as soon as it has
    // nothing left to do but wait — and `ChatRetirer.stillWorking` does not
    // know about child CHATS (it checks the harness subagent roster, the queue
    // and the pane count), so that orchestrator retires `delivered` while its
    // children are still running. Reading `done` here would then abandon every
    // one of their reports: the nested case would look like the feature simply
    // did not happen.
    //
    // Retirement is not a closed door. A message into a retired chat REVIVES it
    // — `noteUserMessage` → `resetChatClock` — which is precisely how
    // `muxpad agent send` re-tasks a finished worker, and collecting the results
    // of work you dispatched is the most legitimate re-tasking there is.
    //
    // `archived` is the one reason that is a person's decision rather than a
    // lifecycle event, and it is the same exception `markParentUnread` carves
    // out: bolding — or here, waking — a chat because the user tidied it would
    // be the app arguing with them.
    if (parent.retired_reason === 'archived')
      return this.abandon(rounds, pending, 'parent chat was archived by the user');
    const pane = this.agentPaneOf(parentTabId);
    if (!pane) return this.abandon(rounds, pending, 'parent has no agent pane');

    // ─── HAS THE BATCH LANDED? ──────────────────────────────────────────────
    const stillWorking = rounds.openRoundCountByParent(parentTabId);
    if (stillWorking > 0) {
      const oldest = pending[0]?.ended_at ?? this.now();
      if (this.now() - oldest < BATCH_MAX_HOLD_MS)
        return { delivered: 0, abandoned: 0, held: pending.length };
      // Past the ceiling: go out incomplete rather than wait on a worker that
      // may never close its round. See BATCH_MAX_HOLD_MS.
      console.warn(
        [
          `[report-delivery] ${parentTabId}: ${pending.length} report(s) held`,
          `>${Math.round(BATCH_MAX_HOLD_MS / 60_000)}m behind ${stillWorking} unfinished`,
          'sibling(s) — delivering the batch incomplete',
        ].join(' '),
      );
    }

    const entries = pending.map((r) => this.entryFor(r));
    const text = renderSpawnDelivery(entries);
    const ids = pending.map((r) => r.id);

    // STAMP FIRST, then send, and revert if it was refused. Of the two ways a
    // send that is not in the transaction can go wrong, a batch delivered twice
    // is much the worse one — the parent acts on the same results again, and in
    // an orchestrator that can mean doing the work twice.
    const stampedAt = this.now();
    rounds.markDelivered(ids, stampedAt);
    let res: SubmitSendResult;
    try {
      res = this.submitSend(pane.id, text);
    } catch (err) {
      rounds.undeliver(ids, stampedAt);
      console.error('[report-delivery] send threw', err);
      return { delivered: 0, abandoned: 0, held: pending.length };
    }
    if (res.status === 'rejected') {
      // Not settled — a refusal is usually transient (a full queue, a runner
      // reconnecting) and the sweep is the retry.
      rounds.undeliver(ids, stampedAt);
      // …but NOT every refusal is transient: a runner whose automatic restarts
      // are exhausted rejects every send, forever. Said once so a stuck batch
      // is findable without the retry becoming the log.
      if (!this.refusalLogged.has(parentTabId)) {
        this.refusalLogged.add(parentTabId);
        console.warn(
          `[report-delivery] ${parentTabId} refused ${pending.length} report(s): ` +
            `${res.reason ?? 'no reason given'} — will retry`,
        );
      }
      return { delivered: 0, abandoned: 0, held: pending.length };
    }
    // A parent that accepts again is worth hearing about next time it does not.
    this.refusalLogged.delete(parentTabId);
    return { delivered: pending.length, abandoned: 0, held: 0 };
  }

  /** Settle rounds there is nobody to deliver. */
  private abandon(rounds: SpawnRoundStore, pending: SpawnRound[], why: string): Flushed {
    rounds.markDelivered(
      pending.map((r) => r.id),
      this.now(),
    );
    console.log(`[report-delivery] settled ${pending.length} report(s) undelivered — ${why}`);
    return { delivered: 0, abandoned: pending.length, held: 0 };
  }

  /**
   * The runner-owned agent pane of this tab, or null.
   *
   * `startup_cmd` is the same test `submitSend` applies before it will queue,
   * checked here so the no-agent case is an ABANDON (settled, logged once)
   * rather than a rejection the sweep retries every minute forever. A tab whose
   * chat face is a plain terminal is a legitimate parent of a sub-chat and has
   * nowhere to put a message.
   */
  private agentPaneOf(tabId: string): { id: string } | null {
    const pane = new PaneStore(this.db)
      .listByTab(tabId)
      .find((p) => p.startup_cmd?.startsWith('muxpad agent'));
    return pane ? { id: pane.id } : null;
  }

  private entryFor(round: SpawnRound): SpawnDeliveryEntry {
    const tab = new TabStore(this.db).getById(round.tab_id);
    return {
      tabId: round.tab_id,
      // The task label is what the parent's own card shows for this child, so
      // the message and the card name the same worker the same way. Falls back
      // to the tab name, then to the id — never to nothing, because the heading
      // is how the reader tells the sections apart.
      name: tab?.spawn_task?.trim() || tab?.name?.trim() || round.tab_id,
      state: round.report_state,
      report: round.report,
      artifacts: round.artifacts,
    };
  }
}
