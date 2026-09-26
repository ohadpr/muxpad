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
      // A pinned root still shows its (stopped) clock; a pinned sub-chat still
      // has none. Pinning answers "does this expire", not "is this work".
      clock: isSubChat(index, tabId)
        ? null
        : chatClock({ started_at: self.clock_started_at ?? now, now, pinned: true }),
    };
  }
  if (isSubChat(index, tabId)) {
    // No clock, and therefore exactly one way out: it delivered, or somebody
    // archived it. Until then it is live for however long the work takes —
    // which is the point. A sub-chat still running after a week is not stale,
    // it is busy, and a clock would retire it mid-sentence.
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
