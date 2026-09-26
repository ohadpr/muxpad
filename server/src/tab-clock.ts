/**
 * WHEN a chat leaves the live list, and who finds out.
 *
 * The arithmetic of the clock is pure and lives in `@muxpad/shared/chat-clock`.
 * What lives here is the part that needs the database: which chats have a
 * clock at all, which have already retired, and the sweep that announces a
 * crossing nobody requested.
 *
 * ── TWO WAYS OUT, ONE DESTINATION ────────────────────────────────────────────
 * A chat is `done` when either is true:
 *
 *   RETIRED — an EVENT. A sub-chat finished its work ('delivered'), or the
 *     user archived it by hand ('archived'). Written down (tabs.retired_at),
 *     because an event nobody recorded did not happen: a delivery is
 *     observable exactly once, at turn-done, and the runtime that saw it is
 *     gone after a restart.
 *   DECAYED — a function of TIME. Four days with no message. Never written,
 *     always computed: a stored flag would need a writer awake at the right
 *     moment and would be wrong, silently and in the direction that HIDES
 *     chats, whenever the server was asleep.
 *
 * Neither deletes anything, and both are undone by the same act — a message
 * ({@link reviveChat}).
 *
 * ── WHY A SUB-CHAT HAS NO CLOCK ──────────────────────────────────────────────
 * An earlier draft had a child SHARE its parent's clock. A screenshot of a
 * real 41-agent sidebar killed that: every row `READY`, every one finished
 * hours earlier, none retired. A shared clock would have kept all 41 of them
 * live for four more days.
 *
 * A sub-chat is not a small chat, it is a piece of WORK. It exists to produce
 * a result, the result goes back to the parent as a card, and at that moment
 * the sub-chat has done its job — so it retires immediately rather than
 * waiting out a clock that was never about it. It stays reachable from the
 * card, from `@`, and inside the parent's `done` group; it simply stops
 * occupying a live row. The semantics are cron's `close_when_done`
 * (server/src/cron/CronScheduler.ts), with one difference: cron CLOSES the
 * tab, and nothing here is ever deleted.
 *
 * Consequently a sub-chat publishes `clock: null` — "there is no clock", which
 * is a different and truer statement than "the clock is at 0%".
 *
 * ── AND WHY A TERMINAL HAS NO CLOCK EITHER ───────────────────────────────────
 * The clock's only exit is a message, and a terminal or a web view has no
 * inbox to put one in. Decaying one does not rest it, it loses it. So the
 * question "does this tab decay at all" has two independent reasons to answer
 * no, and both land on the same published `clock: null` — see
 * {@link hasDecayClock}, which is where that question now lives.
 */
import type { ChatClock } from '@muxpad/shared';
import { chatClock, chatClockDone } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { type RetireReason, type TabClockRow, TabStore } from './store/TabStore.js';

/** All tabs' lifecycle inputs, by id. Build ONCE per list (see
 *  TabStore.clockRows) and hand to every `decorateTab` in that list. */
export type ClockIndex = ReadonlyMap<string, TabClockRow>;

export function clockIndex(db: Database.Database): ClockIndex {
  const rows = new TabStore(db).clockRows();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * ONE coherent read of the lifecycle: every row's inputs, and the instant they
 * are all resolved AT.
 *
 * The two travel together because separating them is a bug with no symptom
 * until it has one. `fill` is continuous in `now` and `done` is a threshold on
 * it, so a list that re-read the clock per row could publish two rows that
 * straddle the same instant — one live, the next done, in a single payload
 * that is supposed to be one picture of the sidebar. Reading the index once
 * per list was always the plan (it is the expensive half); reading the CLOCK
 * once per list is the same idea applied to the cheap half, and it is what
 * makes a response a snapshot rather than a sequence of samples.
 */
export interface ClockSnapshot {
  index: ClockIndex;
  now: number;
}

export function clockSnapshot(db: Database.Database, now: number = Date.now()): ClockSnapshot {
  return { index: clockIndex(db), now };
}

/** What the row publishes: whether this chat is out of the live list, and why. */
export interface TabLifecycle {
  done: boolean;
  /** Absent while the chat is live. */
  done_reason?: RetireReason | 'decayed';
  /** Null for a sub-chat — it has no clock, by design (see the file comment). */
  clock: ChatClock | null;
}

/**
 * Is this chat a SUB-CHAT — work spawned under another chat that still exists?
 *
 * The parent has to still BE there. A dangling `spawned_by` (the parent was
 * deleted; there is no FK, by design) makes this a root in its own right: the
 * work it was doing for someone is not delivering to anyone now, so it gets an
 * ordinary clock rather than hanging live forever waiting to deliver.
 */
export function isSubChat(index: ClockIndex, tabId: string): boolean {
  const row = index.get(tabId);
  if (!row?.spawned_by) return false;
  return index.has(row.spawned_by);
}

/**
 * Does this tab decay at all?
 *
 * TWO tabs in the sidebar carry no clock, for two different reasons that reach
 * the same published shape (`clock: null` — "there is no clock", which is a
 * different and truer claim than "the clock is at 0%"):
 *
 *   A SUB-CHAT is work, not a conversation. It leaves when the work lands.
 *     See the file comment.
 *
 *   A TAB WITH NO AGENT IN IT — a terminal, a web view, an empty tab — has no
 *     inbox. The decay clock has exactly one exit, "send it a message", and
 *     `noteUserMessage` has exactly one production caller (ws.ts `submitSend`)
 *     which runs for runner-owned agent panes and nothing else. So a terminal
 *     that decays does not go quiet for a while, it goes for good: there is no
 *     message you could send it, the client never calls the unarchive route,
 *     and pinning is the only way back. Three of the user's own long-lived
 *     terminals were on the casualty list, and a lifecycle that eats the tab
 *     you keep a server running in has misread what the tab is.
 *
 * Both are still RETIRABLE. Retirement is an act somebody performed — pressing
 * × on a terminal should still file it away. What a terminal must not do is
 * expire because nobody typed in it for four days, which is a fact about the
 * clock and not about the tab.
 *
 * Note this is a property of the tab's CONTENTS, so it moves: a tab whose
 * agent pane is closed stops decaying, and the direction that error falls in
 * is "stays visible", which is the harmless one.
 */
export function hasDecayClock(index: ClockIndex, tabId: string): boolean {
  const row = index.get(tabId);
  if (!row) return false;
  if (!row.has_agent) return false;
  return !isSubChat(index, tabId);
}

/**
 * The lifecycle fields for one chat, exactly as they are published.
 *
 * PINNING is the universal override and the only one: a pinned chat is never
 * done, whether it decayed, delivered or was archived. It no longer propagates
 * from parent to child — there is nothing to propagate now that a sub-chat has
 * no clock of its own to stop.
 */
export function resolveTabClock(index: ClockIndex, tabId: string, now: number): TabLifecycle {
  const self = index.get(tabId);
  // An unknown id (a tab deleted between the read and the decoration) is
  // reported LIVE with no clock. Nothing should render it, and if something
  // does, "still here" is the harmless direction to be wrong in.
  if (!self) return { done: false, clock: null };
  if (self.pinned) {
    return {
      done: false,
      // A pinned chat still shows its (stopped) clock; anything that had no
      // clock still has none. Pinning answers "does this expire", not "is
      // there a clock here to stop".
      clock: hasDecayClock(index, tabId)
        ? chatClock({ started_at: self.clock_started_at ?? now, now, pinned: true })
        : null,
    };
  }
  if (!hasDecayClock(index, tabId)) {
    // No clock, and therefore exactly one way out: it delivered, or somebody
    // archived it. Until then it is live for however long it takes — which is
    // the point. A sub-chat still running after a week is not stale, it is
    // busy, and a clock would retire it mid-sentence; a terminal you have kept
    // open for a month is not stale either, it is a terminal.
    return self.retired_at === null
      ? { done: false, clock: null }
      : { done: true, done_reason: self.retired_reason ?? 'archived', clock: null };
  }
  // A row whose clock was never stamped (a tab created by something that
  // bypassed TabStore.create, or a restore from a pre-v27 backup) is treated
  // as starting NOW rather than at epoch 0 — the migration's "everyone starts
  // fresh" rule applied to a straggler. The alternative reads as instantly
  // expired, which is the one outcome the user explicitly rejected.
  const clock = chatClock({ started_at: self.clock_started_at ?? now, now, pinned: false });
  // RETIREMENT WINS over the clock when both apply: it is the more specific
  // statement ("you archived this"), and it is the one somebody performed.
  if (self.retired_at !== null) {
    return { done: true, done_reason: self.retired_reason ?? 'archived', clock };
  }
  return chatClockDone(clock, now)
    ? { done: true, done_reason: 'decayed', clock }
    : { done: false, clock };
}

/**
 * ONE chat's lifecycle, read directly — for every caller that is decorating a
 * single row rather than a list.
 *
 * It needs at most TWO row reads: this chat, and (only if it names a parent)
 * whether that parent still exists — which is the entire question separating
 * "a sub-chat, retires on delivery" from "a root, decays".
 *
 * This exists because the obvious thing was measurably wrong. Building the
 * whole-table index for a single decoration more than doubled `decorateTab`
 * (296µs → 706µs on a 30-tab database), and `tab.updated` fires on every
 * rename, turn and activity bump — so the cost landed on the hottest path
 * there is. Lists still pre-read the index once and pass it down, which is
 * cheaper again.
 */
export function tabLifecycle(db: Database.Database, tabId: string, now: number): TabLifecycle {
  const tabs = new TabStore(db);
  const self = tabs.clockRow(tabId);
  if (!self) return { done: false, clock: null };
  // Only the PARENT's existence matters, never its contents — a sub-chat has
  // no clock, so there is nothing of the parent's to read.
  const parent = self.spawned_by ? tabs.clockRow(self.spawned_by) : null;
  const index: ClockIndex = new Map(
    parent
      ? [
          [self.id, self],
          [parent.id, parent],
        ]
      : [[self.id, self]],
  );
  return resolveTabClock(index, tabId, now);
}

/** Every tab currently out of the live list, by id. One pass, no per-row
 *  queries. */
export function doneTabIds(index: ClockIndex, now: number): Set<string> {
  const out = new Set<string>();
  for (const id of index.keys()) {
    if (resolveTabClock(index, id, now).done) out.add(id);
  }
  return out;
}

/** Every chat spawned directly under `tabId` that still exists. */
export function childrenOf(index: ClockIndex, tabId: string): string[] {
  const out: string[] = [];
  for (const row of index.values()) {
    if (row.spawned_by === tabId) out.push(row.id);
  }
  return out;
}

/**
 * How many chats spawned under `tabId` are still WORKING — the number the rail
 * publishes as `agents`.
 *
 * WHY THIS IS THE `agents` NUMBER. That field counted harness subagents alone,
 * and muxpad's own pattern is to spawn PANES: a child chat survives a runner
 * restart, keeps its own transcript, and reports back with a card, where a
 * harness subagent dies with the turn that launched it. So the one indicator
 * built to say "this chat has parallel work running" sat at 0 through a dozen
 * working children — the user asked about it twice.
 *
 * DIRECT children only. The rail's number answers "what did this chat start",
 * and a transitive count would make one deep chain read as a fleet.
 *
 * "Still working" is `!done`, resolved through {@link resolveTabClock} rather
 * than by reading `retired_at` here — a sub-chat's only exit is retirement
 * today, but the rule for what `done` means belongs in one place, and a pinned
 * child (never done) has to keep counting.
 */
export function liveChildCount(index: ClockIndex, tabId: string, now: number): number {
  let n = 0;
  for (const row of index.values()) {
    if (row.spawned_by !== tabId) continue;
    if (!resolveTabClock(index, row.id, now).done) n += 1;
  }
  return n;
}

/**
 * The same count for a caller decorating ONE row, without building the
 * whole-table index — the sibling of {@link tabLifecycle}, and for the same
 * measured reason.
 *
 * Two indexed reads: this tab, and its children (`tabs_spawned_by`). The
 * children are enough to resolve themselves: every one of them names THIS tab
 * as its parent, and a row whose parent exists is a sub-chat, which is the only
 * input `done` needs beyond its own retirement.
 */
export function tabLiveChildCount(
  db: Database.Database,
  tabId: string,
  now: number = Date.now(),
): number {
  const tabs = new TabStore(db);
  const self = tabs.clockRow(tabId);
  if (!self) return 0;
  const kids = tabs.childClockRows(tabId);
  if (kids.length === 0) return 0;
  const index: ClockIndex = new Map([[self.id, self], ...kids.map((k) => [k.id, k] as const)]);
  return liveChildCount(index, tabId, now);
}

/**
 * Bring a chat back: un-retire it AND restart its clock, as one act.
 *
 * The two halves cannot be separated. Un-retiring alone would hand the chat
 * back onto whatever clock it had when it left — for an archived chat, very
 * likely an expired one, so it would be `done` again on the very next read and
 * the revival would look like it had silently failed. Restarting alone would
 * leave a retired chat retired, holding a full clock nobody can see.
 *
 * Returns whether the chat exists, so a caller can tell "nothing to do" from
 * "nothing there".
 */
export function reviveChat(db: Database.Database, tabId: string, at: number = Date.now()): boolean {
  const tabs = new TabStore(db);
  if (!tabs.getById(tabId)) return false;
  tabs.unretire(tabId);
  tabs.resetClock(tabId, at);
  return true;
}

/**
 * Restart a chat's clock (and un-retire it) because the user sent it a
 * message. Returns the tabs whose published row changed — this one, or none if
 * it does not exist.
 *
 * It no longer touches the parent or the children. A sub-chat has no clock, so
 * messaging one cannot age or refresh anything but itself, and messaging a
 * parent never had anything to say about its children's work.
 */
export function resetChatClock(
  db: Database.Database,
  tabId: string,
  at: number = Date.now(),
): string[] {
  return reviveChat(db, tabId, at) ? [tabId] : [];
}

/**
 * Announce chats that have just crossed into `done` BY DECAY.
 *
 * Retirement announces itself — something happened, and whatever caused it
 * emits. Decay is the one transition nothing triggers: no request, no
 * keystroke, no turn. Without a tick the sidebar would not move until the
 * client's next poll, and a poll is stopped for a hidden document and a
 * collapsed workspace, so a chat could sit visibly alive for hours after it
 * wasn't.
 *
 * It emits on the RISING EDGE only, and rebuilds the done set from scratch
 * each tick, so a revival (which drops the id from the set) re-arms the
 * announcement for the next expiry with no separate bookkeeping.
 *
 * The FIRST tick is silent by design: everything already done at boot was
 * already done in the payload of every client's first fetch, and announcing it
 * would be a burst of events saying nothing new — once per server restart,
 * proportional to how many chats have accumulated.
 */
export class ChatClockSweeper {
  /** Null until the priming tick has run. */
  private known: Set<string> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database.Database,
    /**
     * Called once per tab that JUST became done.
     *
     * `announce` is false on the PRIMING pass, and the distinction is the
     * reason this is one callback and not two. A chat that decayed while the
     * server was down has still crossed — its `ready` mark is just as stale as
     * any other done chat's, and nothing else will ever clear it, since nobody
     * is going to open a tab that finished last week. So the handler still
     * runs. What it must NOT do is EMIT: those rows were already done in the
     * payload of every client's first fetch, and a boot burst of events
     * proportional to the accumulated backlog tells nobody anything.
     */
    private readonly onDone: (tabId: string, opts: { announce: boolean }) => void,
  ) {}

  /** One pass. Exposed (and clock-injectable) so a test can drive the
   *  crossing deterministically instead of waiting out four days. */
  tick(now: number = Date.now()): string[] {
    const done = doneTabIds(clockIndex(this.db), now);
    const previous = this.known;
    this.known = done;
    const priming = previous === null;
    const crossed = priming
      ? [...done]
      : [...done].filter((id) => !(previous as Set<string>).has(id));
    for (const id of crossed) {
      try {
        this.onDone(id, { announce: !priming });
      } catch {
        // Reconciliation only — one bad handler must not stop the sweep.
      }
    }
    // The priming pass reports nothing CROSSED, because nothing did from any
    // client's point of view — see the constructor comment.
    return priming ? [] : crossed;
  }

  /**
   * Start ticking. One minute, not one second: the thing being watched moves
   * once every four days, and a client that is looking gets the same crossing
   * from its 5s poll anyway — this exists for the clients that are NOT polling.
   */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.tick(); // prime immediately so the first real tick can only be a delta
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
