/**
 * RETIRING a chat, and the `ready` mark that must not outlive it.
 *
 * ── THE EVIDENCE ─────────────────────────────────────────────────────────────
 * A real muxpad sidebar with 41 agent tabs: every row `READY`, in identical
 * green, every one finished hours earlier, none retired. The user had read all
 * of their output as report files without opening a single tab — and `ready`
 * clears only on opening one. A state that is on for forty rows at once is not
 * a state, it is a background colour.
 *
 * Two fixes live here, and they are the same fix seen twice:
 *
 *   1. A SUB-CHAT RETIRES WHEN IT DELIVERS. Its result went back to the parent
 *      as a card; it has done its job; it leaves the live list immediately
 *      rather than waiting out a clock that was never about it.
 *   2. `ready` CLEARS WHEN THE RESULT REACHES THE USER — anywhere. Opening the
 *      tab is one way. The card landing in the parent is another, and it is
 *      the one that actually happens. Retiring a chat therefore clears its
 *      unread marks, every time and by every route: delivery, hand-archive,
 *      and decay.
 *
 * ── WHAT HOLDS A SUB-CHAT OPEN ───────────────────────────────────────────────
 * The keep-list is cron's (CronScheduler.onTurnEnded) — that code has been
 * making this exact judgement in production, and a second, subtly different
 * opinion about "is this agent finished" is how the two drift. Every entry is
 * kept; what changed is that they are now sorted into the TWO QUESTIONS one
 * turn-end answers, because the spawn report needs the first answer and
 * retirement needs both:
 *
 *   NOT FINISHED (`stillWorking`) — nothing has happened yet
 *   · a pending QUESTION — it is blocked on you, which is the opposite of done
 *   · LIVE BACKGROUND SUBAGENTS — the work it spawned outlives the turn that
 *     spawned it, and their results land after this moment
 *   · QUEUED messages — more work is already waiting; let the last one retire it
 *   · a SECOND PANE — a multi-pane tab is not one unit of work
 *
 *   FINISHED, ROW STAYS (`holdOpen`) — it ended, and there is something in
 *   there for you
 *   · a FATAL turn — a crashed run is exactly what you want to look at
 *   · it STOPPED TO ASK YOU SOMETHING (see `awaitingUser`) — the opposite of a
 *     delivery, and the one this list was missing
 *   · an ARTIFACT on the pane — it made you something
 *
 * A worker in the second group reports to its parent and keeps its row; that is
 * the whole reason for the split, and without it the spawn report would be
 * silent about a crash (see `onFinished`).
 *
 * Cron adds one more at the end: it deletes the tab. This does not. Retiring
 * moves the row into the parent's `done` group, where it stays reachable from
 * the card, from `@`, and from a message that revives it.
 *
 * ── THE OTHER WAY A SUB-CHAT ENDS: IT DIES ───────────────────────────────────
 * Everything above hangs off TURN-END, and a runner that DIES never reaches
 * one. So its tab kept `retired_at IS NULL` forever: three workers killed by
 * the ptyd/node-pty bug (new-chat-fix, xws-build, artifact-urls) sat in the
 * sidebar for hours looking exactly like running ones, and were archived by
 * hand. The defect is not that they stayed — it is that **the absence of a
 * death notice was being read as evidence of life**, by the sidebar and by
 * every agent that queried `retired_at IS NULL` to ask who was still working.
 *
 * `onRunnerDead` is that missing edge, and its note carries the argument for
 * why the signal it listens to is already FINAL — the thing that would be
 * catastrophic to get wrong.
 */
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import { type PtydCache, decoratePane, decorateTab } from './ptyd-cache.js';
import { AgentQueueStore } from './store/AgentQueueStore.js';
import { PaneStore } from './store/PaneStore.js';
import { SpawnRoundStore } from './store/SpawnRoundStore.js';
import { type RetireReason, TabStore } from './store/TabStore.js';
import { clockIndex, isSubChat } from './tab-clock.js';

export interface RetireDeps {
  db: Database.Database;
  cache: PtydCache;
  events: EventBus;
  /** The live blocked check (a question is pending). Cron reads the same
   *  signal through its own dep; here the cache already knows. */
  blocked?: ((paneId: string) => boolean) | undefined;
  /**
   * A sub-chat's WORK HAS ENDED — whether or not its row left the live list.
   *
   * The seam the spawn report hangs off (chat/SpawnReportWriter.ts). Its own
   * hook rather than a line inside `retireChat` because the two questions have
   * different answers: a crashed worker and one that produced a file both KEEP
   * their live rows on purpose, and both have unambiguously stopped — so a
   * report triggered by retirement would be silent about the two cases the
   * parent most needs told (see `ChatRetirer.onTurnEnded`).
   *
   * Called synchronously from the bus handler, so an implementation must be
   * fire-and-forget and must never throw. This file deliberately knows nothing
   * about models.
   */
  onFinished?:
    | ((tabId: string, paneId: string, opts: { crashed: boolean; awaiting: boolean }) => void)
    | undefined;
  /**
   * Did this worker STOP TO ASK the user something?
   *
   * `delivered` and `awaiting you` were one state and they are opposites — one
   * wants archiving, the other wants your attention. Retirement fires at
   * TURN-END, so a worker that investigated, published a page and ended its turn
   * asking which option to take was filed as finished (`cross-ws`, in the
   * database: `retired_reason = delivered`).
   *
   * Injected, like `blocked`, so this file keeps deciding POLICY and reads no
   * transcripts of its own. The implementation is chat/awaiting.ts, and its note
   * carries the argument for reading the last MESSAGE rather than the pane's
   * `blocked` flag — which `stillWorking` already consults, and which cannot see
   * a question an agent merely wrote in prose.
   */
  awaitingUser?: ((paneId: string) => boolean) | undefined;
}

/**
 * Clear every "done, unreviewed" mark on a chat — the tab's own, and each of
 * its panes'.
 *
 * This is the `ready` EXPIRY, and it is a write rather than a rendering rule
 * on purpose: `ready` is persisted precisely so a result found while you were
 * away survives a restart, so the thing that ends it has to be persisted too.
 * Reading it away at decoration time would leave the flag in the database,
 * true forever, waiting to reappear the moment anything revived the row.
 *
 * Emits a `pane.updated` per pane it clears, so other clients drop the bold
 * immediately instead of waiting out a poll that is stopped for a hidden
 * document. The TAB event is the caller's — it has more to say than this does.
 */
export function clearReadyMarks(deps: RetireDeps, tabId: string): boolean {
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);
  let changed = false;
  if (tabs.isUnread(tabId)) {
    tabs.setUnread(tabId, false);
    changed = true;
  }
  for (const p of panes.listByTab(tabId)) {
    if (!p.unread) continue;
    panes.setUnread(p.id, false);
    changed = true;
    const fresh = panes.getById(p.id);
    if (fresh)
      deps.events.emit({
        type: 'pane.updated',
        tab_id: fresh.tab_id,
        pane: decoratePane(deps.cache, fresh, deps.db),
      });
  }
  return changed;
}

/**
 * Move a chat into the `done` group and take its `ready` mark — and its OPEN
 * ROUND — with it.
 *
 * ONE function for every door — a sub-chat delivering, a user archiving, a
 * runner dying — because they are the same destination reached three ways, and
 * the thing that must not diverge between them is precisely the part that is
 * easy to forget on the second copy: clearing the marks.
 *
 * ── THE ROUND CLOSES HERE, NOT AT ONE CALLER ─────────────────────────────────
 * `A RETIRED CHAT HAS NO OPEN ROUND` is the invariant the cards need, and until
 * now only the turn-end path upheld it (SpawnReportWriter.onFinished). The
 * HAND-ARCHIVE path never did, and the live database says so: all three workers
 * archived by hand after the ptyd bug killed them still carry
 * `spawn_rounds.ended_at IS NULL` — so their cards are still mid-flight in the
 * parent's log, with a spinner, after the tabs themselves were dealt with.
 *
 * Putting it at the one door means a reason added later cannot forget it. It is
 * a no-op when there is nothing open, so the delivered path — which closes the
 * round first, synchronously, before the model call — is unaffected.
 *
 * Returns whether anything moved. Retiring an already-retired chat is a no-op
 * (the store keeps the original stamp), but the marks are still cleared — a
 * chat can perfectly well be re-marked unread after it retired, and a second
 * pass is the cheapest way to be right about that.
 */
export function retireChat(deps: RetireDeps, tabId: string, reason: RetireReason): boolean {
  const tabs = new TabStore(deps.db);
  const retired = tabs.retire(tabId, reason);
  // Stamped with the RETIREMENT instant and not with `now`, so the round's end
  // and the row's `retired_at` agree — they are the same moment, and the card
  // sorts on one while the `done` group sorts on the other. Re-read rather than
  // assumed, because `retire` is idempotent: for a chat that was already
  // retired the stamp we want is the ORIGINAL one, not this call's.
  const closed = new SpawnRoundStore(deps.db).close(
    tabId,
    tabs.clockRow(tabId)?.retired_at ?? Date.now(),
  );
  const cleared = clearReadyMarks(deps, tabId);
  if (!retired && !cleared && !closed) return false;
  const fresh = tabs.getById(tabId);
  if (fresh)
    deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, fresh) });
  return true;
}

/**
 * Watch for sub-chats finishing their work, and retire them.
 *
 * Subscribes to the SAME `agent_turn` event the cron scheduler uses, for the
 * same reason: it is the one signal that means "the agent stopped", emitted
 * once, from the one place that knows (ws.ts). Nothing here reaches into the
 * ws layer.
 */
export class ChatRetirer {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: RetireDeps) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.events.subscribe((e) => {
      if (e.type !== 'agent_turn') return;
      if (e.phase !== 'done' && e.phase !== 'fatal') return;
      this.onTurnEnded({ pane_id: e.pane_id, phase: e.phase });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Exposed so a test can drive the transition without a runner. */
  onTurnEnded(e: { pane_id: string; phase: 'done' | 'fatal' }): boolean {
    const panes = new PaneStore(this.deps.db);
    const pane = panes.getById(e.pane_id);
    if (!pane) return false;
    const index = clockIndex(this.deps.db);
    // ONLY sub-chats. A top-level chat is a conversation you are having; it
    // leaves on its clock or when you archive it, never because an agent in it
    // stopped talking.
    if (!isSubChat(index, pane.tab_id)) return false;
    // ── TWO QUESTIONS, ONE TURN-END ──────────────────────────────────────────
    // "Has this worker finished?" and "should its row leave the live list?" are
    // different, and the old single keep-list answered them together. Splitting
    // it is what lets the spawn report cover the cases that need it most: a
    // FATAL run and one that produced an ARTIFACT both keep their rows on
    // purpose, and both have plainly stopped working.
    if (this.stillWorking(e)) return false;
    // Read ONCE and passed both ways: the card has to say "awaiting you" using
    // the same judgement that decided not to retire, or the row and its card
    // would be free to disagree about the same worker.
    const awaiting = this.deps.awaitingUser?.(e.pane_id) === true;
    this.deps.onFinished?.(pane.tab_id, e.pane_id, { crashed: e.phase === 'fatal', awaiting });
    // Retirement proper: pinning outranks it, and so does anything the agent
    // still has FOR YOU that retiring would bury.
    if (index.get(pane.tab_id)?.pinned) return false;
    if (this.holdOpen(e, awaiting)) return false;
    return retireChat(this.deps, pane.tab_id, 'delivered');
  }

  /**
   * ITS RUNNER IS GONE FOR GOOD — the supervisor gave up. Retire it as `died`.
   *
   * Wire this to the dead-runner sweep's GIVE-UP (ws.ts, beside
   * `cache.setDead`). Everything else in this class hangs off a turn ending,
   * and a dead runner never ends one; without this edge its tab keeps
   * `retired_at IS NULL` forever and reads as working. That is the whole bug.
   *
   * ── WHY THIS SIGNAL IS ALREADY FINAL, AND NO GRACE IS ADDED HERE ───────────
   * Retiring on the first sighting of `status === 'dead'` would archive every
   * chat on the machine the next time ptyd bounced. It does not, because what
   * this listens to is NOT "a pane looked dead" — it is the sweep's GIVE-UP,
   * which a pane can only reach by surviving all four rails in
   * respawn-policy.ts:
   *
   *   · 30 s STARTUP GRACE — a pane created seconds ago is never judged;
   *   · the ptyd FOREGROUND PROBE SUCCEEDED and found no agent-runner. A ptyd
   *     outage makes it REJECT, and the sweep then skips the pane entirely:
   *     no attempt spent, no cooldown anchor moved (see ws.ts, "A THROW IS NOT
   *     DEATH"). This is why a bounce cannot retire anything — a bounce never
   *     reaches the branch that calls this at all;
   *   · 3 REAL RESPAWN ATTEMPTS, each a killPane + ensurePane that retypes the
   *     startup command and resumes the session, 45 s apart. So ≥135 s of
   *     sustained death with three recoveries attempted and failed;
   *   · 60 s PROBATION — a runner that comes back and STAYS wipes the record.
   *
   * The grace window, the respawn attempt and the registry check are therefore
   * all already spent by the time this is called, and re-deriving any of them
   * here would be the second, subtly different opinion this file's header
   * warns about (see the note on cron's keep-list). Subscribe to the verdict;
   * never re-judge it.
   *
   * ── WHY IT RETIRES WHEN A FATAL TURN DELIBERATELY DOES NOT ─────────────────
   * `holdOpen` keeps a crashed RUN's row live, and that is not in tension with
   * this, because the two rows make different claims. A fatal turn leaves a
   * live pane with a live agent — you can open it, read it, re-run it — so its
   * live row is TRUE. A runner the supervisor has given up on leaves no agent
   * at all, so its live row is FALSE, and it is exactly that false row that
   * cost three jobs. Nothing is buried either way: the row moves into the
   * parent's `done` group, still reachable from the card, from `@`, and from a
   * message that revives it (which respawns the runner).
   *
   * ── AND IT IS REPORTED AS A CRASH, NOT AS A DELIVERY ───────────────────────
   * `onFinished(crashed: true)` closes the round and puts `crashed` on the row
   * — a state the report writer records on EVERY path, including a worker with
   * no transcript at all. So the card says "Crashed before it produced
   * anything" instead of wearing a green tick, which is the whole point of
   * keeping `died` distinct from `delivered`.
   */
  onRunnerDead(paneId: string): boolean {
    const panes = new PaneStore(this.deps.db);
    const pane = panes.getById(paneId);
    if (!pane) return false;
    const index = clockIndex(this.deps.db);
    // ONLY sub-chats, exactly as at turn-end. A top-level chat is a
    // conversation you are having; its agent dying is a thing to FIX, and
    // filing the conversation away is not the response to it.
    if (!isSubChat(index, pane.tab_id)) return false;
    if (index.get(pane.tab_id)?.pinned) return false;
    // A MULTI-PANE TAB IS NOT ONE UNIT OF WORK — the single clause of
    // `stillWorking` that survives a death. One agent dying says nothing about
    // the others, and retiring the tab would hide them.
    //
    // The other three clauses are all assertions that the agent is STILL
    // WORKING, which is precisely what it is not: a pending question belongs
    // to a runner that no longer exists, its background subagents died with
    // it, and the sweep has already cleared its queue on the way to this call
    // (nothing will ever drain it). Treating any of them as a reason to keep
    // the row live is how the corpse stayed in the sidebar in the first place.
    if (panes.listByTab(pane.tab_id).length > 1) return false;
    this.deps.onFinished?.(pane.tab_id, paneId, { crashed: true, awaiting: false });
    return retireChat(this.deps, pane.tab_id, 'died');
  }

  /**
   * The agent is NOT FINISHED — or this tab is not one unit of work, which comes
   * to the same thing: there is nothing yet to retire or to report on.
   *
   * The first half of cron's keep-list, verbatim in intent (see the file
   * comment).
   */
  private stillWorking(e: { pane_id: string; phase: 'done' | 'fatal' }): boolean {
    if (this.deps.blocked?.(e.pane_id) === true) return true; // blocked on you
    // Its own BACKGROUND SUBAGENTS are still running. A turn that ends while
    // the roster is non-empty has not delivered — the work it spawned is
    // still out there, and its results arrive after this moment. The same
    // roster is what makes `getStatus` say `working`, so retiring here
    // published a row that read `done: true, status: 'working'`: the sidebar
    // simultaneously claiming this is finished and that it is not.
    //
    // The DURABLE server-owned roster, not a pty heuristic — ptyd-cache
    // mirrors it from the ws layer precisely because a background subagent
    // parked in one long tool call emits nothing for minutes.
    if (this.deps.cache.getSubagentCount(e.pane_id) > 0) return true;
    // More of its work is already queued — let the LAST turn retire it.
    if (new AgentQueueStore(this.deps.db).count(e.pane_id) > 0) return true;
    // A multi-pane tab is not a single unit of work: one agent finishing says
    // nothing about the others, and retiring the tab would hide them.
    return new PaneStore(this.deps.db).listByTab(this.tabOf(e.pane_id)).length > 1;
  }

  /**
   * The work has ended, but the ROW stays live — because there is something in
   * there for you to look at that retiring would bury.
   *
   * The second half of cron's keep-list. Both of these are states the spawn
   * report still describes: "it crashed after doing X" and "it made you this"
   * are the two most useful things a card in the parent's log can say.
   */
  private holdOpen(e: { pane_id: string; phase: 'done' | 'fatal' }, awaiting: boolean): boolean {
    if (e.phase === 'fatal') return true; // a crashed run is what you want to look at
    // IT STOPPED TO ASK YOU SOMETHING. The newest member of this list and the
    // one that motivated splitting it: a worker waiting on an answer is the
    // opposite of one that delivered, and archiving it — which also clears the
    // `ready` mark that is the only thing saying it wants you — is the worst
    // response available.
    if (awaiting) return true;
    return this.hasArtifact(e.pane_id); // it made you something
  }

  private tabOf(paneId: string): string {
    return new PaneStore(this.deps.db).getById(paneId)?.tab_id ?? '';
  }

  private hasArtifact(paneId: string): boolean {
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

/** What one boot's reconcile actually changed. Returned (and logged) rather
 *  than silent, because a repair nobody can see is indistinguishable from one
 *  that did not run. */
export interface ReconcileResult {
  /** Retired tabs whose round was still open — closed at their own stamp. */
  roundsClosed: number;
  /** Live sub-chats no supervisor could ever reach — retired `died`. */
  orphansRetired: number;
}

/**
 * ONE IDEMPOTENT PASS AT BOOT over the states nothing live can reach.
 *
 * Two repairs, and one deliberate refusal that is the important part.
 *
 * ── (a) A RETIRED CHAT WITH AN OPEN ROUND ────────────────────────────────────
 * Unambiguously wrong, and it needs no judgement about liveness at all: the tab
 * left the live list, so the round it was in cannot still be running. This is
 * the state the hand-archives left behind — measured on the live database, all
 * three workers killed by the ptyd bug and archived by hand still had
 * `ended_at IS NULL`, so their cards are mid-flight in the parent's log to this
 * day. `retireChat` now closes the round at every door, so this is the backlog
 * that door was never opened for.
 *
 * Closed at the tab's OWN `retired_at`, not at boot: the honest "when" is when
 * the chat ended, and stamping it `now` would sort every recovered card to the
 * top of the log at every restart.
 *
 * ── (b) A LIVE SUB-CHAT NO SUPERVISOR CAN EVER REACH ─────────────────────────
 * The dead-runner sweep judges panes matching `startup_cmd LIKE 'muxpad
 * agent%'`. A live sub-chat with no such pane is invisible to it — no turn of
 * its will ever end, and no sweep will ever declare it dead — so it is live
 * forever with nothing able to change that. There is nothing that could come
 * back, so no grace is owed and none is given.
 *
 * Empty on this install today. It is a GUARD, not a sweep with a population,
 * and it is cheap enough to be worth having for the case where a pane is
 * deleted out from under a running child.
 *
 * ── THE REFUSAL: "retire live sub-chats whose runner is absent at boot" ──────
 * That is the naive fix, and it archives the machine. At boot EVERY runner is
 * absent — they reconnect over ws seconds later, and the panes ptyd lost to a
 * restart are respawned by the sweep with their sessions resumed. A pass that
 * read absence as death would retire every healthy chat on the box on the
 * first tick after every restart, which is worse than the bug it fixes.
 *
 * What covers those is the sweep itself: anything still genuinely dead is
 * re-judged within ~2.5 minutes of boot, after three respawn attempts, and
 * `ChatRetirer.onRunnerDead` then retires it through exactly the same edge as
 * a death at runtime. THE SWEEP IS THE BOOT RECONCILE — it is the code that
 * has been making this call correctly in production, and this function's job
 * is only the two states the sweep structurally cannot see.
 */
export function reconcileDeadChats(deps: RetireDeps): ReconcileResult {
  const rounds = new SpawnRoundStore(deps.db);
  const out: ReconcileResult = { roundsClosed: 0, orphansRetired: 0 };

  // (a) Retired, with a round still open. One row per tab: `close` ends the
  // single open round, which is the invariant SpawnRoundStore is built around.
  const stale = deps.db
    .prepare(
      `SELECT DISTINCT t.id AS tab_id, t.retired_at AS retired_at
         FROM tabs t JOIN spawn_rounds r ON r.tab_id = t.id
        WHERE t.retired_at IS NOT NULL AND r.ended_at IS NULL`,
    )
    .all() as Array<{ tab_id: string; retired_at: number }>;
  for (const row of stale) {
    if (rounds.close(row.tab_id, row.retired_at)) out.roundsClosed += 1;
  }

  // (b) Live sub-chats with no pane the dead-runner sweep will ever look at.
  // `isSubChat` (not a bare `spawned_by`) so a child whose parent is gone is
  // left alone — it is a root in its own right and decays on its own clock.
  const index = clockIndex(deps.db);
  const orphans = deps.db
    .prepare(
      `SELECT t.id AS tab_id
         FROM tabs t
        WHERE t.spawned_by IS NOT NULL
          AND t.retired_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM panes p
                           WHERE p.tab_id = t.id AND p.startup_cmd LIKE 'muxpad agent%')`,
    )
    .all() as Array<{ tab_id: string }>;
  for (const { tab_id: tabId } of orphans) {
    if (!isSubChat(index, tabId)) continue;
    if (index.get(tabId)?.pinned) continue;
    if (retireChat(deps, tabId, 'died')) out.orphansRetired += 1;
  }

  if (out.roundsClosed > 0 || out.orphansRetired > 0) {
    console.log(
      `[tab-retire] boot reconcile: closed ${out.roundsClosed} stranded round(s), retired ${out.orphansRetired} unreachable sub-chat(s)`,
    );
  }
  return out;
}
