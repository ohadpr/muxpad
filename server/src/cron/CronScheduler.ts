// The tick. ONE `setInterval` over PERSISTED state — never N in-memory timers.
//
// That choice is the whole feature: `crons.next_due_at` lives in SQLite, so a
// server restart (which the dev loop does constantly) neither loses a schedule
// nor drifts it, and a laptop that was asleep can be told what it missed. In-
// memory timers can do neither, which is exactly why the harnesses' own crons
// can't either (docs/plans/2026-08-14-muxpad-cron.md §1).
//
// Everything below is policy on top of ONE injection primitive: `submitSend`.
// There is deliberately no second path into a session — the queue's durability,
// its one-message-per-turn drain, its restart-safety and its 200-message bound
// are all inherited for free, and its return value is the ONLY honest answer to
// "did that land?". Ignoring that return value would rebuild silent failure one
// layer up, which is the entire thing this replaces (§6 risk 1).
import { type Cron, type CronRun, messageIsFromCron, renderCronMarker } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { bootstrapTab, deleteTabCascade } from '../agent-tab.js';
import { wrapCarryover } from '../chat/summarize.js';
import type { EventBus } from '../events.js';
import { type PtydCache, decorateTab } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { AgentQueueStore } from '../store/AgentQueueStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import type { TabActivity } from '../tab-activity.js';
import { CronStore } from './CronStore.js';
import { firesDue } from './schedule.js';

/** Tick cadence. 30s granularity is ample for agent work and cheap: one
 *  indexed query per pass, nothing else, whether there are 0 crons or 200. */
export const CRON_TICK_MS = 30_000;

/**
 * Skip ticking for this long after boot — the same guard `attachAttentionPush`
 * uses to stop a restart replay re-blasting pushes. Without it, an HMR restart
 * during the dev loop fires every due cron before the runners have re-
 * registered, and every one of those lands as a `rejected` + a fail_streak
 * increment. The grace costs at most one delayed fire; its absence costs
 * spurious auto-disables.
 */
export const CRON_STARTUP_GRACE_MS = 15_000;

/**
 * A slot older than this is a MISSED fire (catch-up territory) rather than
 * simply "this tick's fire arriving a beat late". Three ticks of slack, so a
 * slow pass or a busy event loop can never make a punctual fire look like a
 * recovered outage — and so the `[N missed]` marker means something.
 */
export const CRON_MISSED_GRACE_MS = 3 * CRON_TICK_MS;

/** Auto-disable after this many consecutive failures, with a push. */
export const CRON_FAIL_LIMIT = 3;

/** Context fill above which `on_context` policies engage. */
export const CRON_CONTEXT_HIGH_PCT = 80;

/**
 * Ceiling on ENABLED crons. We deliberately do NOT copy the harnesses' 7-day
 * auto-expiry — a schedule that silently stops is the exact failure this
 * feature exists to remove — so the runaway bound has to be something other
 * than time. A count ceiling is: it can never lose you a job you are still
 * using, and a hundred live schedules already means someone lost track.
 */
export const MAX_ENABLED_CRONS = 100;

export interface CronSchedulerDeps {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
  tabActivity?: TabActivity | undefined;
  /** The ONE injection primitive (ws.ts). Its return value is recorded verbatim. */
  submitSend: (paneId: string, text: string) => { status: string; reason?: string | undefined };
  /** Live turn state for a pane: true/false from the runner registry, null when
   *  no runner is connected. NOT the pty `busy` heuristic. */
  turnActive?: ((paneId: string) => boolean | null) | undefined;
  /** Context-window fill (0-100) for a pane, or null when unknown — no runner
   *  yet, or a backend with no window (codex/cursor). Unknown means `fire`. */
  contextPct?: ((paneId: string) => number | null) | undefined;
  /** Epoch ms of the last HUMAN send into a pane (ws.ts's conn.lastSendAt), or
   *  null. Drives `quiet_mins`. */
  lastHumanSendAt?: ((paneId: string) => number | null) | undefined;
  /** Relay a slash command (`compact`) to a pane's runner. */
  slash?: ((paneId: string, cmd: 'compact') => boolean) | undefined;
  /** Is the pane's agent blocked on a question right now? */
  blocked?: ((paneId: string) => boolean) | undefined;
  /** Push a message to the user's devices (fail-streak auto-disable). */
  notify?: ((title: string, body: string) => void) | undefined;
  /**
   * A handoff briefing for a pane whose session is about to be ROTATED into a
   * fresh tab (`on_context=rotate`) — "here is what the conversation you're
   * taking over had established". null means one couldn't be produced, and
   * the scheduler then refuses to rotate rather than firing blind.
   *
   * Injected as a dependency so the SOURCE is swappable: today it's an ad-hoc
   * transcript summary (chat/summarize.ts); when muxpad grows a per-chat
   * dossier this becomes a dossier read and nothing here changes.
   */
  carryover?: ((paneId: string) => Promise<string | null>) | undefined;
  /** Injectable clock — every test drives time, never sleeps. */
  now?: (() => number) | undefined;
}

export interface CronFireResult {
  outcome: string;
  detail?: string | undefined;
  targetPane?: string | undefined;
  targetTab?: string | undefined;
  /** True when the cron should NOT be re-anchored — it will be retried on the
   *  next tick (quiet-hours deferral only). */
  defer?: boolean;
}

export class CronScheduler {
  readonly store: CronStore;
  private readonly panes: PaneStore;
  private readonly tabs: TabStore;
  private readonly queue: AgentQueueStore;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly bootAt: number;
  private ticking = false;
  /**
   * Panes with an in-flight turn this scheduler started, keyed by pane id →
   * cron id. Two jobs: the `overlap=skip` check (a turn we started is still
   * outstanding) and `close_when_done` (this turn is the one whose end closes
   * the tab). Rebuilt from nothing after a restart, deliberately: the DURABLE
   * half of overlap detection is the queue scan, and the worst case here is
   * one extra fire after a restart, never a missed one.
   */
  private readonly inflight = new Map<string, string>();
  /** Panes whose finishing turn should close their (cron-created) tab. */
  private readonly closeOnDone = new Map<string, { cronId: string; tabId: string }>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: CronSchedulerDeps) {
    this.store = new CronStore(deps.db);
    this.panes = new PaneStore(deps.db);
    this.tabs = new TabStore(deps.db);
    this.queue = new AgentQueueStore(deps.db);
    this.now = deps.now ?? Date.now;
    this.bootAt = this.now();
  }

  /** Start the tick and subscribe to turn lifecycle. Mirrors pane-reaper's
   *  unref'd interval so the tick can never hold shutdown open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CRON_TICK_MS);
    this.timer.unref?.();
    this.unsubscribe = this.deps.events.subscribe((e) => {
      if (e.type === 'agent_turn' && (e.phase === 'done' || e.phase === 'fatal')) {
        void this.onTurnEnded(e.pane_id, e.phase);
      }
      // A pane going away takes its in-flight bookkeeping with it; the cron
      // row itself is handled on the next tick (disable + push), because
      // "your job's target is gone" deserves a notification, not a silent drop.
      if (e.type === 'pane.removed') {
        this.inflight.delete(e.pane_id);
        this.closeOnDone.delete(e.pane_id);
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * One scheduling pass. Single-flight: a slow new-tab fire (which awaits ptyd)
   * must not let the next interval start a second pass over the same due rows —
   * that is a duplicate-fire race, not a performance question.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    const now = this.now();
    if (now - this.bootAt < CRON_STARTUP_GRACE_MS) return;
    this.ticking = true;
    try {
      for (const cron of this.store.listDue(now)) {
        // Re-read: a long await earlier in this pass may have disabled or
        // deleted this row (auto-disable, a concurrent DELETE).
        const fresh = this.store.getById(cron.id);
        if (!fresh || !fresh.enabled || fresh.next_due_at > now) continue;
        await this.runDue(fresh, now);
      }
    } catch (err) {
      // A throw here would kill the interval callback's promise silently and,
      // worse, leave `ticking` set — a scheduler that never ticks again.
      console.error('[cron] tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Fire NOW, ignoring the schedule (`muxpad cron run`). Testing a cron before
   *  trusting it is the affordance harness crons structurally cannot offer. */
  async runNow(cronId: string): Promise<CronFireResult | null> {
    const cron = this.store.getById(cronId);
    if (!cron) return null;
    const at = this.now();
    const result = await this.fire(cron, at, 0, at);
    this.record(cron, at, at, result, { manual: true });
    return result;
  }

  // ── Due handling ─────────────────────────────────────────────────────────

  private async runDue(cron: Cron, now: number): Promise<void> {
    // Enumerate NOMINAL slots. `next_due_at` carries this cron's deterministic
    // jitter, so the nominal anchor is exactly next_due_at - jitter_ms, and a
    // nominal slot S is due once now >= S + jitter — i.e. S <= now - jitter.
    // Doing the arithmetic here (rather than jittering inside the expression
    // walker) keeps cron-parser answering the one question it is good at.
    const jitter = cron.jitter_ms;
    const { fires: nominal, capped } = firesDue(
      cron.schedule,
      cron.tz,
      cron.next_due_at - jitter,
      now - jitter,
    );
    const fires = nominal.map((t) => t + jitter);
    if (fires.length === 0) {
      // The anchor is due but the expression yields nothing at/before now —
      // only reachable if the schedule was edited under a stale anchor. Re-arm.
      this.store.setNextDue(cron.id, this.store.nextFireAfter(cron.id, now));
      return;
    }
    // Everything older than the grace is a MISSED fire; the newest slot is
    // "this tick's fire" and is never treated as recovery.
    const missed = fires.filter((t) => t < now - CRON_MISSED_GRACE_MS);
    const current = fires[fires.length - 1] as number;

    if (cron.catchup === 'all') {
      // Each tick genuinely matters — enqueue them all. They serialize through
      // the pane's queue (one per turn), so this is a batch, not a stampede.
      let last: CronFireResult | null = null;
      for (const due of fires) {
        const r = await this.fire(cron, due, 0, now);
        this.record(cron, due, now, r, { capped });
        last = r;
        if (r.defer) break;
      }
      if (last?.defer) return; // quiet hours — keep the anchor, retry next tick
    } else if (cron.catchup === 'skip' && missed.length > 0 && missed.length === fires.length) {
      // Everything due is stale and the policy says drop it. Record ONE row so
      // the history shows the outage rather than a suspicious silence.
      this.store.addRun({
        cron_id: cron.id,
        due_at: current,
        fired_at: now,
        outcome: 'missed',
        detail: `${missed.length} fire(s) dropped (catchup=skip)`,
      });
      this.store.recordOutcome(cron.id, { at: now, status: 'missed', ok: true });
    } else {
      // 'once' (and 'skip' with a live current slot): ONE fire, carrying a
      // marker for whatever was collapsed into it.
      const collapsed = cron.catchup === 'once' ? missed.length : 0;
      const r = await this.fire(cron, current, collapsed, now);
      this.record(cron, current, now, r, { capped });
      if (r.defer) return; // quiet hours — leave the anchor alone
    }
    // Re-anchor from the nominal clock (now - jitter), so a jittered fire can't
    // make the NEXT slot slip by another jitter each time — the offset is a
    // constant shift of the schedule, never a compounding drift.
    this.store.setNextDue(cron.id, this.store.nextFireAfter(cron.id, now - jitter));
  }

  /** Persist the verdict: a run row, the cron's last_status, the fail streak,
   *  and — at the limit — the auto-disable + push that stops it failing you
   *  silently. */
  private record(
    cron: Cron,
    dueAt: number,
    firedAt: number,
    result: CronFireResult,
    opts: { capped?: boolean; manual?: boolean } = {},
  ): CronRun | null {
    if (result.defer) {
      // A deferral is not a run. Recording one per 30s tick while the user
      // chats would be the single fastest way to fill cron_runs with noise.
      this.store.recordOutcome(cron.id, { at: firedAt, status: 'deferred:quiet', ok: true });
      return null;
    }
    const failed = result.outcome === 'rejected' || result.outcome.startsWith('error');
    const detail = [result.detail, opts.capped ? 'catch-up list was capped' : null]
      .filter(Boolean)
      .join('; ');
    const run = this.store.addRun({
      cron_id: cron.id,
      due_at: dueAt,
      fired_at: firedAt,
      target_pane: result.targetPane ?? null,
      target_tab: result.targetTab ?? null,
      outcome: result.outcome,
      detail: detail || null,
    });
    // `last_status` records submitSend's answer VERBATIM where there was one —
    // 'sent' | 'queued' | 'rejected' — prefixed with error: when it failed, so
    // `cron list` shows the real reason instead of a summary of it.
    const status = failed
      ? `error:${result.detail ? result.detail.slice(0, 120) : result.outcome}`
      : result.outcome;
    // A MANUAL `cron run` must not push the schedule toward auto-disable: the
    // user is standing right there watching it fail, and one bad hand-test
    // should not silently retire a working nightly job.
    if (opts.manual) {
      this.store.recordOutcome(cron.id, { at: firedAt, status, ok: !failed });
      return run;
    }
    const streak = this.store.recordOutcome(cron.id, { at: firedAt, status, ok: !failed });
    if (failed && streak >= CRON_FAIL_LIMIT) {
      this.store.setEnabled(cron.id, false);
      // The ⏱ on the nav row is derived from ENABLED crons, so a disable has
      // to re-emit the tab or the glyph lingers until the next 5s poll.
      emitCronTabUpdate(this.deps, cron.target_pane);
      this.deps.notify?.(
        `cron ${cron.name} disabled`,
        `${streak} consecutive failures — last: ${status}. Fix it, then \`muxpad cron resume ${cron.name}\`.`,
      );
      console.error(`[cron] ${cron.name} (${cron.id}) auto-disabled after ${streak} failures`);
    }
    return run;
  }

  // ── Firing ───────────────────────────────────────────────────────────────

  private async fire(
    cron: Cron,
    dueAt: number,
    missed: number,
    now: number,
  ): Promise<CronFireResult> {
    const text = renderCronMarker({ id: cron.id, name: cron.name, at: dueAt, missed }, cron.prompt);
    return cron.target_kind === 'new-tab'
      ? this.fireNewTab(cron, text, now)
      : this.firePane(cron, text, now);
  }

  private async firePane(cron: Cron, text: string, now: number): Promise<CronFireResult> {
    const paneId = cron.target_pane;
    if (!paneId) return { outcome: 'error', detail: 'no target pane' };
    const pane = this.panes.getById(paneId);
    if (!pane) {
      // The pane is GONE (deleted, or its tab was). A cron that spins on
      // `error` forever against a target that can never come back is noise, so
      // retire it once, loudly, instead of failing three times first.
      this.store.setEnabled(cron.id, false);
      this.deps.notify?.(
        `cron ${cron.name} disabled`,
        'its target pane no longer exists — recreate it and point the cron at the new pane.',
      );
      console.error(`[cron] ${cron.name} (${cron.id}) disabled — target pane ${paneId} is gone`);
      return { outcome: 'error', detail: 'target pane no longer exists' };
    }
    // FAIL FAST on a dead runner. `dead` means automatic restarts were
    // exhausted — submitSend would reject anyway, but reading it first makes
    // the run history say WHY in one word instead of quoting a paragraph of
    // restart guidance, and it costs no round trip.
    //
    // The RAW bit, deliberately, not `getStatus`: that ranks `working` above
    // `dead` (right for the nav — a spinner says more than a ×) and a dead
    // pane whose pty is still dribbling output would therefore read `working`,
    // silently disarming this guard in precisely the case it exists for.
    if (this.deps.cache.isDead(paneId))
      return { outcome: 'error', detail: 'dead', targetPane: paneId };

    // Don't barge into a live conversation. DEFER (not drop): a cron must not
    // be lost because you happened to be chatting when it came due.
    if (cron.quiet_mins > 0) {
      const last = this.deps.lastHumanSendAt?.(paneId) ?? null;
      if (last !== null && now - last < cron.quiet_mins * 60_000)
        return { outcome: 'deferred', detail: 'quiet', targetPane: paneId, defer: true };
    }

    // Overlap: is THIS cron's previous fire still outstanding? Two signals —
    // a message of ours still sitting in the durable queue, and a turn we
    // started that hasn't ended. Turn state comes from the runner registry
    // (agent_turn / turnActive), never the pty `busy` heuristic, which reads
    // true for a tailing dev server and false for a silently-thinking agent.
    if (cron.overlap === 'skip' && this.isOutstanding(cron.id, paneId))
      return { outcome: 'skipped', detail: 'overlap', targetPane: paneId };

    // Context policy. Unknown fill (no runner yet, or a backend without a
    // window) is treated as `fire` — refusing to run because we can't measure
    // would make codex/cursor panes un-cronnable.
    const pct = this.deps.contextPct?.(paneId) ?? null;
    if (pct !== null && pct > CRON_CONTEXT_HIGH_PCT) {
      if (cron.on_context === 'skip')
        return { outcome: 'skipped', detail: `context ${Math.round(pct)}%`, targetPane: paneId };
      if (cron.on_context === 'rotate') {
        // Where does the rotation LAND? A pane cron carries no workspace of its
        // own, so fall back to the pane's own workspace — the rotated session
        // belongs next to the one it replaced. Resolved BEFORE the (paid,
        // model-backed) briefing so a rotate with nowhere to go fails free.
        const workspaceId = cron.workspace_id ?? this.tabs.getWorkspaceId(pane.tab_id) ?? null;
        if (!workspaceId)
          return {
            outcome: 'error',
            detail: 'rotate: no workspace to rotate into',
            targetPane: paneId,
          };
        // ROTATION MUST CARRY CONTEXT. A fresh tab that knows nothing about
        // the conversation it just replaced doesn't produce a clean answer,
        // it produces a confidently amnesiac one — and it looks identical to
        // a good one. So take a handoff briefing from the pane first and
        // inject it ahead of the prompt.
        //
        // If we can't produce one, DON'T rotate. Losing a fire is recoverable
        // (the next slot comes around, and the run log says why this one
        // didn't); silently amnesiac output is not.
        const carry = await this.carryoverFor(paneId);
        if (!carry)
          return {
            outcome: 'skipped',
            detail: `carryover-failed (context ${Math.round(pct)}%) — refusing to rotate into a blank session`,
            targetPane: paneId,
          };
        const r = await this.fireNewTab(
          cron,
          `${wrapCarryover(carry)}\n\n${text}`,
          now,
          workspaceId,
        );
        return {
          ...r,
          detail: [`rotated at ${Math.round(pct)}% context with carryover`, r.detail]
            .filter(Boolean)
            .join('; '),
        };
      }
      if (cron.on_context === 'compact-first') {
        // Both the compact and the prompt queue as normal turns, so ordering
        // is free — no need to wait for the compaction to finish.
        this.deps.slash?.(paneId, 'compact');
      }
    }

    const res = this.deps.submitSend(paneId, text);
    if (res.status === 'sent') this.inflight.set(paneId, cron.id);
    return {
      // VERBATIM. See the header: recording our own summary of submitSend's
      // answer instead of its answer is how silent failure gets rebuilt.
      outcome: res.status,
      ...(res.reason ? { detail: res.reason } : {}),
      targetPane: paneId,
    };
  }

  /** The rotation handoff, guarded: a source that throws is a source that
   *  produced nothing, never a crash inside the tick. */
  private async carryoverFor(paneId: string): Promise<string | null> {
    if (!this.deps.carryover) return null;
    try {
      const text = await this.deps.carryover(paneId);
      return text?.trim() ? text.trim() : null;
    } catch (err) {
      console.error('[cron] carryover source failed', err);
      return null;
    }
  }

  private async fireNewTab(
    cron: Cron,
    text: string,
    _now: number,
    /** Overrides the cron's own workspace — the `rotate` path lands the fresh
     *  session in the ROTATING PANE's workspace, not a column the cron row
     *  never had. */
    workspaceOverride?: string,
  ): Promise<CronFireResult> {
    const workspaceId = workspaceOverride ?? cron.workspace_id;
    if (!workspaceId) return { outcome: 'error', detail: 'no target workspace' };
    // Guardrail: a nightly cron must not leave 30 tabs after a month. Prune
    // the recorded tabs to those that still exist, then honour max_open.
    const open = this.store.openTabs(cron.id).filter((id) => this.tabs.getById(id) !== null);
    if (open.length >= cron.max_open) {
      this.store.setOpenTabs(cron.id, open);
      return {
        outcome: 'skipped',
        detail: `max_open ${cron.max_open} reached (${open.length} still open)`,
      };
    }
    const created = await bootstrapTab(this.deps, {
      workspace_id: workspaceId,
      name: cron.name,
      bootstrap: 'agent',
      // No icon — see the note on the same omission in routes/tabs.ts. A
      // stored `⏱` made every scheduled tab identical AND spent the free icon
      // write the generator needs to give this one a glyph about its actual
      // subject, which is far more useful than "this is a cron".

      ...(cron.cwd ? { cwd: cron.cwd } : {}),
      ...(cron.model ? { model: cron.model } : {}),
      ...(cron.backend === 'codex' || cron.backend === 'cursor' ? { backend: cron.backend } : {}),
      // A scheduled job's report wants terse and result-first — exactly the
      // ⚡ Do contract — so new-tab fires default to it. Pane mode inherits
      // the pane's own mode instead; there is nothing to choose there.
      mode: cron.mode === 'deep' ? 'deep' : 'do',
    });
    if (!created.pane) return { outcome: 'error', detail: 'tab bootstrap produced no pane' };
    const paneId = created.pane.id;
    this.store.setOpenTabs(cron.id, [...open, created.tab.id]);
    // The runner needs a second or two to register. We do NOT poll for it:
    // submitSend on a runner-owned pane QUEUES, and the queue drains on the
    // runner's hello — the same path a message sent from a phone takes.
    const res = this.deps.submitSend(paneId, text);
    if (cron.close_when_done)
      this.closeOnDone.set(paneId, { cronId: cron.id, tabId: created.tab.id });
    if (res.status === 'sent') this.inflight.set(paneId, cron.id);
    return {
      outcome: res.status,
      ...(res.reason ? { detail: res.reason } : {}),
      targetPane: paneId,
      targetTab: created.tab.id,
    };
  }

  /** Is a fire from `cronId` still outstanding on this pane? */
  private isOutstanding(cronId: string, paneId: string): boolean {
    // Durable half: our message is still waiting in the persisted queue.
    if (this.queue.list(paneId).some((q) => messageIsFromCron(q.text, cronId))) return true;
    // Live half: a turn WE started is still running. Both conditions matter —
    // `turnActive` alone would also block on a turn the human started, and the
    // queue alone misses the (long) window where our message is mid-turn.
    if (this.inflight.get(paneId) !== cronId) return false;
    return this.deps.turnActive?.(paneId) === true;
  }

  // ── Turn lifecycle ───────────────────────────────────────────────────────

  private async onTurnEnded(paneId: string, phase: 'done' | 'fatal'): Promise<void> {
    this.inflight.delete(paneId);
    const pending = this.closeOnDone.get(paneId);
    if (!pending) return;
    this.closeOnDone.delete(paneId);
    // Every session is archived and FTS-searchable (server/src/archive/), so
    // closing a finished cron tab loses nothing — the conversation is still
    // findable with `muxpad search`. Two things still hold it open, because
    // both mean the agent has something FOR YOU that a search won't surface:
    //   - a question is pending (it is blocked, waiting on an answer), and
    //   - an artifact was produced (an attachment on the pane).
    // A `fatal` also keeps the tab: a crashed run is exactly what you want to
    // look at.
    if (phase === 'fatal') {
      this.noteTabKept(pending.cronId, pending.tabId, 'turn ended fatally');
      return;
    }
    if (this.deps.blocked?.(paneId) === true) {
      this.noteTabKept(pending.cronId, pending.tabId, 'a question is pending');
      return;
    }
    if (this.paneHasArtifact(paneId)) {
      this.noteTabKept(pending.cronId, pending.tabId, 'the run produced an artifact');
      return;
    }
    // The pane may have more of OUR queued messages (catchup=all) — closing
    // now would drop them. Let the last one close it.
    if (this.queue.count(paneId) > 0) {
      this.closeOnDone.set(paneId, pending);
      return;
    }
    await deleteTabCascade(this.deps, pending.tabId);
    this.store.setOpenTabs(
      pending.cronId,
      this.store.openTabs(pending.cronId).filter((id) => id !== pending.tabId),
    );
  }

  private noteTabKept(cronId: string, tabId: string, why: string): void {
    console.log(`[cron] keeping tab ${tabId} open — ${why}`);
    this.store.addRun({
      cron_id: cronId,
      due_at: this.now(),
      fired_at: this.now(),
      target_tab: tabId,
      outcome: 'kept',
      detail: why,
    });
  }

  private paneHasArtifact(paneId: string): boolean {
    try {
      const row = this.deps.db
        .prepare('SELECT COUNT(*) AS n FROM attachments WHERE pane_id = ?')
        .get(paneId) as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Re-emit a pane's TAB after a cron's enabled state changed. The nav's ⏱ is
 * derived from ENABLED crons only, so without this a pause/resume/delete only
 * shows up on the client's next 5s poll — and an auto-disable (which happens
 * while nobody is looking) would leave the glyph lying about a dead schedule.
 * Shared with the routes so every write path re-emits identically.
 */
export function emitCronTabUpdate(
  deps: { db: Database.Database; cache: PtydCache; events: EventBus },
  paneId: string | null,
): void {
  if (!paneId) return;
  const pane = new PaneStore(deps.db).getById(paneId);
  if (!pane) return;
  const tab = new TabStore(deps.db).getById(pane.tab_id);
  if (!tab) return;
  deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, tab) });
}
