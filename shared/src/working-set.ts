/**
 * THE WORKING SET — the handful of chats you are actually moving between.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────
 * Measured on one real install: 85 live top-level chats in the rail, 18 of
 * them typed in over three days, and FOUR of those taking 58% of the typing.
 * Chat switches preceded ~60% of all messages — 92 switches in 167 messages on
 * one day. So the rail is an 85-row list serving a 4–6 row set, about sixty
 * times a day, and the unread marks had quietly become the navigation because
 * they were the only part of it that changed.
 *
 * ─── Why the slots are STABLE, which is the whole design ──────────────────
 * The obvious build is "last N, most recent first". It is the one thing that
 * cannot work as a permanently visible strip: the list reorders AS A RESULT OF
 * YOUR OWN CLICK. You open slot 3, it becomes slot 1, the chat you came from
 * becomes slot 2, and everything you had learned about where things are is
 * wrong — again on the next message.
 *
 * Everyone who ships MRU freezes it inside a gesture: Alt-Tab and VS Code's
 * Ctrl+Tab are both strict MRU and both hold the order still while the key is
 * down. A strip has no key to hold. So it is not sorted at all: a chat takes
 * the first FREE slot and keeps it until it leaves. Nothing moves because you
 * used it, which is what makes muscle memory — and a numbered shortcut —
 * possible.
 *
 * ─── Why six, and why sixteen hours ───────────────────────────────────────
 * Both simulated against 5,208 real messages over 21 days, replaying the
 * stream through this algorithm and counting how often a return found its slot
 * still there.
 *
 *   CAP. 4 → 95.1% · 5 → 96.9% · 6 → 97.8% · 8 → 98.8%. Six also DROPS the
 *   strip's churn against five (10.2 changes a day vs 12.1) — better on both
 *   axes, which is rare. Eight buys another point and costs two more rows,
 *   which is where a strip stops being glanceable and becomes a list.
 *
 *   DECAY. Barely moves the hit rate (at six slots: 4h → 96.0%, 8h → 96.9%,
 *   never → 97.8%), and the intuition is backwards — a SHORT decay makes the
 *   strip churn MORE, because chats keep falling out and climbing back in
 *   (1h → 22.3 changes a day, never → 8.1). Capacity does most of the
 *   evicting; decay is a tidy-up.
 *
 *   What decay actually buys is the one thing a hit rate cannot see: THE
 *   STRIP YOU COME BACK TO. Across sixteen breaks of 4h or more, a decay of
 *   4h or less showed ZERO slots on return — a blank strip, which is the
 *   85-row list with extra steps. 8h showed 31 slots of which 52% were used
 *   again within two hours; 24h showed 66 at 38%; never showed 80 at 31%.
 *   After a six-hour break: 8h → 67% relevant, never → 22%. Eight hours shows
 *   FEWER AND BETTER. It looked like the knee.
 *
 * ─── WHY IT IS NOT EIGHT HOURS ────────────────────────────────────────────
 * The simulation scored every break the same way, and one break is not like
 * the others: A NIGHT. "Overnight I go to sleep and wake up and some of them
 * are out" — and that is the one return where the strip is worth the most,
 * because the whole morning is spent picking up exactly what you put down.
 *
 * Eight hours cannot survive it. Stop at 18:00 and the strip is empty by
 * 02:00; there is no bedtime late enough and no morning early enough to get
 * a working day across an 8h gap. The sampled breaks were mostly mid-day
 * ones, so the metric never saw this and the number looked fine.
 *
 * SIXTEEN. It covers the realistic night end to end — stop as early as 16:00,
 * return as late as 08:00 — which is the whole point. It stops short of 24h,
 * where a chat you touched once yesterday afternoon is still holding a slot
 * through the following evening, and where the simulation measured the
 * precision actually falling off (66 slots at 38% relevance against 31 at
 * 52%). The cap of six bounds the damage either way: decay decides whether
 * the strip is THERE in the morning, and capacity decides what is in it.
 */

/** One occupied slot. `at` is the last time you sent this chat a message. */
export interface WorkingSlot {
  tabId: string;
  at: number;
}

/** How many chats the strip holds. See the file note for the simulation. */
export const WORKING_SET_SIZE = 6;

/** How long a slot survives without a message from you. See the file note. */
export const WORKING_SET_DECAY_MS = 16 * 60 * 60 * 1000;

/**
 * ── DECAY DECIDES WHO GETS REPLACED, NOT WHO IS SHOWN ────────────────────
 *
 * It used to be REMOVED on read, and the array then closed up — so everything
 * after it moved. In a vertical band that was a row sliding by one position;
 * as TABS it is the one thing a tab bar may never do, and it was reported as
 * exactly that.
 *
 * There is no arrangement in which a slot both disappears on a timer and
 * leaves its neighbours alone. So the timer stops deciding what is VISIBLE
 * and decides what is REPLACEABLE instead: a stale slot keeps its position
 * until a new chat takes it, which is the first thing that would have taken
 * a free one anyway.
 *
 * What decay was for survives intact — "the strip you come back to", fewer
 * and better slots after a break — because a stale slot is still the first
 * one spent. What goes is a tab vanishing while you are looking at the row,
 * and the renumbering underneath it.
 */
export function isStale(slot: WorkingSlot, now: number, decayMs = WORKING_SET_DECAY_MS): boolean {
  return now - slot.at > decayMs;
}

/**
 * You sent `tabId` a message.
 *
 * Already in a slot → its `at` moves and NOTHING ELSE CHANGES. That is the
 * stability promise, and it is the whole reason the strip is worth having.
 *
 * Not in a slot → it takes the first free one. Order within the array IS the
 * order on screen, so this appends rather than inserts; inserting is MRU
 * wearing a different hat.
 *
 * No free slot → the least recently used one is evicted. This is the only
 * place recency is allowed to act, and it acts on the row you are NOT looking
 * at, which is the difference that matters.
 */
export function touchWorkingSet(
  slots: readonly WorkingSlot[],
  tabId: string,
  now: number,
  opts: { size?: number; decayMs?: number } = {},
): WorkingSlot[] {
  const size = opts.size ?? WORKING_SET_SIZE;
  const decay = opts.decayMs ?? WORKING_SET_DECAY_MS;
  // NOT pruned. A stale slot keeps its place until something takes it — see
  // `isStale`. Pruning here is what made the strip renumber itself whenever a
  // slot aged out, which as tabs is the one unforgivable move.
  const live = slots.slice();
  const at = live.findIndex((s) => s.tabId === tabId);
  if (at >= 0) {
    live[at] = { tabId, at: now };
    return live;
  }
  if (live.length < size) return [...live, { tabId, at: now }];
  // ── WHOSE SLOT DOES A NEW CHAT TAKE ──────────────────────────────────
  // A STALE one first, oldest first, which is what decay now buys: the
  // strip you come back to still loses its stale slots, it just loses them
  // to something rather than to a clock. Failing that, the least recently
  // used — the one you are not looking at, which is the difference that
  // matters. Either way it is replaced IN PLACE and nothing else moves.
  const stale = live
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => isStale(s, now, decay))
    .sort((a, b) => a.s.at - b.s.at)[0];
  const victim =
    stale?.i ??
    live.reduce((worst, s, i) => (s.at < (live[worst] as WorkingSlot).at ? i : worst), 0);
  live[victim] = { tabId, at: now };
  return live;
}

/**
 * "Not now" — free a slot by hand.
 *
 * It frees the slot and nothing else: the chat stays exactly where it lives,
 * un-archived, unretired, untouched. A destructive action on a convenience
 * strip would make the strip frightening, and the strip's whole value is that
 * reaching for it costs nothing.
 *
 * The slots after it CLOSE UP rather than leaving a hole. A gap would be a
 * promise the next chat lands there, which is not how the first-free rule
 * works once anything else has moved.
 */
export function removeFromWorkingSet(slots: readonly WorkingSlot[], tabId: string): WorkingSlot[] {
  return slots.filter((s) => s.tabId !== tabId);
}

/** Parse whatever is in storage. Anything unreadable is an empty strip —
 *  a working set is a convenience, and it may never be the reason a rail
 *  fails to render. */
export function parseWorkingSet(raw: string | null | undefined): WorkingSlot[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is WorkingSlot =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as WorkingSlot).tabId === 'string' &&
          Number.isFinite((s as WorkingSlot).at),
      )
      .slice(0, WORKING_SET_SIZE);
  } catch {
    return [];
  }
}
