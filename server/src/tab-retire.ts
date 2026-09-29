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
 */
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import { type PtydCache, decoratePane, decorateTab } from './ptyd-cache.js';
import { AgentQueueStore } from './store/AgentQueueStore.js';
import { PaneStore } from './store/PaneStore.js';
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
 * Move a chat into the `done` group and take its `ready` mark with it.
 *
 * ONE function for both doors — a sub-chat delivering and a user archiving —
 * because they are the same destination reached two ways, and the thing that
 * must not diverge between them is precisely the part that is easy to forget
 * on the second copy: clearing the marks.
 *
 * Returns whether anything moved. Retiring an already-retired chat is a no-op
 * (the store keeps the original stamp), but the marks are still cleared — a
 * chat can perfectly well be re-marked unread after it retired, and a second
 * pass is the cheapest way to be right about that.
 */
export function retireChat(deps: RetireDeps, tabId: string, reason: RetireReason): boolean {
  const tabs = new TabStore(deps.db);
  const retired = tabs.retire(tabId, reason);
  const cleared = clearReadyMarks(deps, tabId);
  if (!retired && !cleared) return false;
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
