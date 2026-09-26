/**
 * WHICH clock a chat reads, and who finds out when one runs out.
 *
 * The arithmetic of the clock itself is pure and lives in
 * `@muxpad/shared/chat-clock`. What lives here is the part that needs the
 * database: a chat spawned under another chat SHARES its parent's clock, so
 * resolving one row means walking the spawn tree to its root.
 *
 * ── WHY A SHARED CLOCK, NOT AN INHERITED ONE ─────────────────────────────────
 * The rule is "work spawned under a chat should not outlive it". A child with
 * its own independent clock breaks that in both directions: a child you last
 * touched today survives a parent you abandoned a week ago, and a parent you
 * are actively using shows children rotting underneath it. One clock per TREE,
 * owned by the root, makes the family expire together — and makes a message to
 * any member revive the whole family, which is what "revivable by sending it a
 * message" has to mean once a chat has children.
 *
 * ── DONE IS COMPUTED, NEVER STORED ───────────────────────────────────────────
 * There is no `done` column, and that is deliberate. A chat crosses into done
 * because TIME passed, not because anything happened — so a stored flag would
 * need a writer awake at the exact moment, and would be wrong (silently, and
 * in the direction that hides chats) whenever the server was asleep. The row is
 * derived at read time from one timestamp; the sweeper below exists only to
 * ANNOUNCE a crossing, never to define one.
 */
import type { ChatClock } from '@muxpad/shared';
import { chatClock, chatClockDone } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { type TabClockRow, TabStore } from './store/TabStore.js';

/**
 * A hard stop on the ancestor walk. A cycle cannot be created by any route
 * that exists (`spawned_by` is write-once, at creation, and a tab cannot be
 * its own parent), but the walk is on the sidebar's hot path and "cannot
 * happen" is not a reason to let a corrupt row hang the server.
 */
const MAX_SPAWN_DEPTH = 32;

/** All tabs' clock inputs, by id. Build ONCE per list (see TabStore.clockRows)
 *  and hand to every `decorateTab` in that list. */
export type ClockIndex = ReadonlyMap<string, TabClockRow>;

export function clockIndex(db: Database.Database): ClockIndex {
  const rows = new TabStore(db).clockRows();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Walk to the row whose clock this chat actually reads: its furthest ancestor
 * through `spawned_by`.
 *
 * A dangling `spawned_by` (the parent tab was deleted — there is no FK, by
 * design) stops the walk and the child becomes its own root. That is the right
 * reading: the chat it was working under no longer exists, so there is nothing
 * left for it to expire alongside, and its own `clock_started_at` — stamped at
 * creation like every row's — is a real timestamp to fall back to.
 */
export function clockRoot(index: ClockIndex, tabId: string): TabClockRow | undefined {
  let row = index.get(tabId);
  if (!row) return undefined;
  for (let depth = 0; depth < MAX_SPAWN_DEPTH; depth++) {
    if (!row.spawned_by) return row;
    const parent = index.get(row.spawned_by);
    if (!parent || parent.id === row.id) return row;
    row = parent;
  }
  return row;
}

/**
 * The lifecycle fields for one chat, exactly as they are published.
 *
 * PINNING propagates DOWN, because a shared clock that one member can stop has
 * to stop for the family: pinning a parent is how you say "this work matters,
 * keep it", and having its children decay out from under it would answer a
 * question nobody asked. A pinned CHILD stops only itself — it read the
 * parent's clock, and the pin is it opting out of that.
 */
export function resolveTabClock(
  index: ClockIndex,
  tabId: string,
  now: number,
): { done: boolean; clock: ChatClock } {
  const self = index.get(tabId);
  const root = clockRoot(index, tabId);
  // An unknown id (a tab deleted between the read and the decoration) gets a
  // full, stopped clock rather than a done one. Nothing should render it, and
  // if something does, "alive" is the harmless direction to be wrong in.
  if (!self || !root) {
    return {
      done: false,
      clock: chatClock({ started_at: now, now, pinned: true }),
    };
  }
  const pinned = self.pinned || root.pinned;
  // A row whose clock was never stamped (a tab created by something that
  // bypassed TabStore.create, or a restore from a pre-v27 backup) is treated
  // as starting NOW rather than at epoch 0 — the migration's "everyone starts
  // fresh" rule applied to a straggler. The alternative reads as instantly
  // expired, which is the one outcome the user explicitly rejected.
  const started_at = root.clock_started_at ?? now;
  const clock = chatClock({ started_at, now, pinned });
  return { done: chatClockDone(clock, now), clock };
}

/** Every tab currently past its clock, by id. One pass, no per-row queries. */
export function doneTabIds(index: ClockIndex, now: number): Set<string> {
  const out = new Set<string>();
  for (const id of index.keys()) {
    if (resolveTabClock(index, id, now).done) out.add(id);
  }
  return out;
}

/**
 * Restart the clock for the chat `tabId` belongs to, and report every tab
 * whose published row changed as a result.
 *
 * The write lands on the ROOT (one clock per tree), and the returned ids are
 * the whole tree — a child publishes its parent's clock, so a reset that
 * refreshed only the row you typed in would leave every child rendering an
 * age that no longer exists until the next poll.
 *
 * Returns an empty array for an unknown tab, so a caller can treat "nothing to
 * announce" and "nothing to write" as the same case.
 */
export function resetChatClock(
  db: Database.Database,
  tabId: string,
  at: number = Date.now(),
): string[] {
  const index = clockIndex(db);
  const root = clockRoot(index, tabId);
  if (!root) return [];
  new TabStore(db).resetClock(root.id, at);
  return [root.id, ...descendantsOf(index, root.id)];
}

/** Every tab beneath `rootId` in the spawn tree, at any depth. */
export function descendantsOf(index: ClockIndex, rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const row of index.values()) {
    if (!row.spawned_by) continue;
    const list = children.get(row.spawned_by);
    if (list) list.push(row.id);
    else children.set(row.spawned_by, [row.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue; // cycle guard, same reasoning as the walk
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Announce chats that have just crossed into `done`.
 *
 * The crossing is the one state change in this whole feature that NOTHING
 * triggers — no request, no keystroke, no agent turn. Without a tick the
 * sidebar would not move until the next poll, and a poll is stopped for a
 * hidden document and a collapsed workspace, so a chat could sit visibly alive
 * for hours after it wasn't.
 *
 * It emits on the RISING EDGE only, and rebuilds the done set from scratch
 * each tick, so a revival (which clears the id from the set) re-arms the
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
    /** Called once per tab that JUST became done. */
    private readonly onDone: (tabId: string) => void,
  ) {}

  /** One pass. Exposed (and clock-injectable) so a test can drive the
   *  crossing deterministically instead of waiting out four days. */
  tick(now: number = Date.now()): string[] {
    const done = doneTabIds(clockIndex(this.db), now);
    const previous = this.known;
    this.known = done;
    if (previous === null) return []; // priming pass — see the class comment
    const crossed = [...done].filter((id) => !previous.has(id));
    for (const id of crossed) {
      try {
        this.onDone(id);
      } catch {
        // Announcement only — one bad emit must not stop the rest of the sweep.
      }
    }
    return crossed;
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
