import type Database from 'better-sqlite3';
import { agentPaneForTab } from '../browser/ResumeAfterHandback.js';
import type { CronStore } from './CronStore.js';

/**
 * A SCHEDULED JOB'S RESULT, INTO THE CHAT IT BELONGS IN.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
 * `opening-review` fired every morning from 21 to 29 October. Nine runs, every
 * one logged `sent`, zero of them read by anybody: the job wrote ordinary prose
 * into a fresh worker that was then deleted. Its own prompt now shouts
 * "DELIVER THE WHOLE REPORT WITH `muxpad say`" — a workaround that protects
 * exactly one schedule. Two other watchers (`vuori-31-watch-v2`,
 * `cloudflared-weekly-upgrade`) forward their results by embedding
 * `muxpad agent send <paneId>` in their prompt text, so the destination is a
 * pane id frozen into prose and correct only until that pane is replaced.
 *
 * So a schedule declares a result DESTINATION (`crons.result_tab`), a fire's
 * spoken text is captured at turn-end (cron/say-capture), and this hands it
 * over and records that it did.
 *
 * ── A QUEUE DRAIN, NOT AN EVENT HANDLER ─────────────────────────────────────
 * Same shape as chat/report-delivery, for the same reasons. The outbox is
 * durable (`cron_runs.result IS NOT NULL AND delivered_at IS NULL`), so a
 * result survives the server bouncing between capture and delivery — and this
 * install bounces. The nudge at turn-end is an optimisation; the sweep is the
 * mechanism.
 *
 * ── THE DESTINATION IS RESOLVED AT SEND TIME ────────────────────────────────
 * From the TAB, every time. That is the half of the fix the hardcoded
 * `agent send` cannot have: a chat's agent pane is replaced by a respawn, by a
 * backend switch, by a restart, and a destination written down in a prompt in
 * October is a destination that was right in October.
 *
 * ── AND SILENCE IS NEVER BROKEN ─────────────────────────────────────────────
 * Nothing is delivered unless the fire SPOKE and the schedule DECLARED a
 * destination. A watcher that checks something every weekday and finds nothing
 * captures nothing, so there is nothing here to send. That is not a special
 * case in this file; it is the absence of a row.
 */

/** How often the outbox is swept. Matches the delivery sweep next door: a
 *  result is not urgent, and a minute is the granularity a cron thinks in. */
export const RESULT_SWEEP_MS = 60_000;

/**
 * How many sweeps a result may fail to land before the run is called failed.
 *
 * NOT ONE. A rejection is usually transient — a runner mid-restart, a queue
 * momentarily full — and failing a run for that would cry wolf on every
 * respawn. Not unbounded either, which is the shape of the original bug: a
 * result retried forever at a reader that does not exist is indistinguishable
 * from one that was read. Three minutes of trying, then the run says so.
 */
export const DELIVERY_ATTEMPTS = 3;

export interface ResultDeliveryDeps {
  db: Database.Database;
  store: CronStore;
  /** ws.ts `submitSend` — the one injection primitive, synchronous. */
  submitSend: (paneId: string, text: string) => { status: 'sent' | 'queued' | 'rejected' };
  now?: () => number;
}

export interface ResultSweep {
  delivered: number;
  /** Results with a destination that cannot take them right now. */
  held: number;
  /** Runs given up on, and marked failed. */
  failed: number;
}

/**
 * What a delivered result READS like in the destination chat.
 *
 * Named, because a paragraph arriving in a conversation with no provenance is
 * a paragraph somebody has to go and identify. The schedule's name is the
 * whole attribution anybody needs — `muxpad cron show <name>` has the rest.
 */
export function renderResult(cronName: string, result: string): string {
  return `<muxpad-cron-result name="${cronName}">\n${result}\n</muxpad-cron-result>`;
}

export class ResultDelivery {
  private readonly deps: ResultDeliveryDeps;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * runId → failed attempts, this process.
   *
   * In memory on purpose. A restart forgetting the count means a result gets
   * three more tries, and the cost of that is a few more attempts at a
   * destination that may well have come back with the restart — against a
   * column that would make every transient rejection durable.
   */
  private readonly attempts = new Map<string, number>();

  constructor(deps: ResultDeliveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), RESULT_SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over the outbox.
   *
   * SYNCHRONOUS FROM READ TO STAMP, like report-delivery's flush and for the
   * same reason: two passes interleaving would both read the same undelivered
   * row and both send it. Nothing here awaits, so Node's single thread does
   * the mutual exclusion a lock would otherwise have to.
   */
  sweep(): ResultSweep {
    const out: ResultSweep = { delivered: 0, held: 0, failed: 0 };
    let pending: ReturnType<CronStore['outbox']>;
    try {
      pending = this.deps.store.outbox();
    } catch (err) {
      console.error('[cron-result] could not read the outbox', err);
      return out;
    }
    for (const row of pending) {
      try {
        this.deliverOne(row, out);
      } catch (err) {
        console.error(`[cron-result] ${row.cronName}: delivery threw`, err);
        out.held += 1;
      }
    }
    return out;
  }

  private deliverOne(
    row: { runId: string; cronId: string; cronName: string; tabId: string; result: string },
    out: ResultSweep,
  ): void {
    const paneId = agentPaneForTab(this.deps.db, row.tabId);
    if (!paneId) {
      // THE DESTINATION HAS NO AGENT IN IT. A terminal, a web view, or a chat
      // that has been deleted — none of which can be told anything. Counted as
      // an attempt rather than failed outright, because a chat whose runner is
      // still coming up looks exactly like this for a few seconds.
      this.note(row, out, 'the destination chat has no agent in it');
      return;
    }
    const res = this.deps.submitSend(paneId, renderResult(row.cronName, row.result));
    if (res.status === 'rejected') {
      this.note(row, out, 'the destination refused the message');
      return;
    }
    // `queued` COUNTS AS DELIVERED, deliberately. The queue is durable and
    // drains on the runner's hello — the same path a message from a phone
    // takes — so holding the stamp back would re-send on the next sweep and
    // deliver twice. (report-delivery made the same call for the same reason,
    // and carries `noteQueueDropped` for the one case where a queue row is
    // thrown away. This does not, yet: a cron result is a paragraph, and
    // losing one to a wiped queue costs a morning's digest rather than a
    // worker's whole output. Stated rather than silently different.)
    this.deps.store.markDelivered(row.runId, this.now());
    this.attempts.delete(row.runId);
    out.delivered += 1;
  }

  /** One failed attempt, and the verdict once there have been enough. */
  private note(
    row: { runId: string; cronId: string; cronName: string },
    out: ResultSweep,
    why: string,
  ): void {
    const tries = (this.attempts.get(row.runId) ?? 0) + 1;
    this.attempts.set(row.runId, tries);
    if (tries < DELIVERY_ATTEMPTS) {
      out.held += 1;
      return;
    }
    // THE RUN FAILS, which is the whole point of a receipt. An undeliverable
    // result used to be indistinguishable from a delivered one — both read
    // `sent` — so the schedule looked healthy while nobody heard from it.
    //
    // `failDelivery`, NOT `finishRun`: the turn-end has already corrected this
    // row to `done`, and `finishRun` only moves rows still reading
    // `sent`/`queued`, so it would quietly do nothing here. See its note.
    this.attempts.delete(row.runId);
    this.deps.store.failDelivery(row.runId, `result undelivered: ${why}`);
    // AND THE SCHEDULE'S OWN STREAK, so a destination that is permanently
    // wrong reaches the auto-disable instead of failing politely forever. The
    // same reasoning as the never-started sweep: a job nobody hears from must
    // not look healthy.
    this.deps.store.recordOutcome(row.cronId, {
      at: this.now(),
      status: 'error:result undelivered',
      ok: false,
    });
    console.warn(`[cron-result] ${row.cronName}: giving up — ${why}`);
    out.failed += 1;
  }
}
