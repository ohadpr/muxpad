/**
 * Remembered scroll positions for chat panes. A ChatPane loses its scroll
 * constantly — a reload unmounts it, and tab/pane/face switches hide it with
 * display:none (which zeroes scrollTop) — so returning to a chat always
 * snapped to the bottom.
 *
 * ── WHY A MESSAGE ID, NOT A RATIO ────────────────────────────────────────────
 * This used to store position as a RATIO of the scrollable range, on the theory
 * that a ratio "degrades proportionally" when the document height changes. It
 * does — and proportional degradation is precisely the bug, because a chat log
 * grows at BOTH ends:
 *
 *   · below, when the agent keeps talking while you're away;
 *   · ABOVE, every time the older-history pager prepends a 128 KB batch.
 *
 * A ratio only preserves the reader's place when the content above them is
 * fixed. Prepend `g` pixels of older history and the honest target is
 * `R·range + g` (the same messages, pushed down); the ratio computes
 * `R·(range + g)`, which is smaller for every R < 1 — so the reader is dragged
 * BACK into older history, further with every batch. Worse, the ratio is a
 * FIXED POINT: the settling-restore loop re-applies it each frame, so it
 * silently overrides the prepend compensation `scrollTopAfterOlderPrepend`
 * just computed. Measured on the real stack: parked at message 70, reopened at
 * message 165, with the final scroll ratio equal to the stored one to three
 * decimals.
 *
 * So the unit of memory is a MESSAGE: `anchorId` (an event id, which is stable
 * across prepends, appends, dedupe and reconnects) plus `anchorOffset`, how far
 * that message's top sat above the viewport top. Restoring means "put message
 * X back under the reader's eyes", which is invariant to everything the
 * document does around it. `ratio` is still written, purely as the fallback for
 * when the anchored message isn't rendered (a fresh mount opens on a 128 KB
 * tail; anything older has to be paged back in first — see the seek in
 * ChatPane's restore effect).
 *
 * ── WHY "CAUGHT UP", NOT "PINNED" ────────────────────────────────────────────
 * Anchoring to a message fixed the MECHANISM: whatever position we remember, we
 * restore it exactly. The report kept coming back anyway, because the position
 * being remembered was wrong — and it was wrong for a reader who had not
 * knowingly scrolled anywhere.
 *
 * `pinnedToBottom` in the component answers "should live output scroll itself
 * into view while I am watching?", and its threshold is deliberately tight
 * (40 px): auto-scrolling someone who nudged up a line is obnoxious. That flag
 * used to be persisted AS THE RE-ENTRY POLICY too — and re-entry is a different
 * question, answered on a different timescale. One wheel notch off the bottom
 * (Chromium: ~120 px, i.e. a single trackpad nudge to re-read the last line)
 * stored `pinned: false` plus an anchor on the newest message. That is harmless
 * while nothing arrives. Then the agent runs a ten-minute turn, and the SAME
 * anchor — faithfully, exactly restored — is now thirty messages above the
 * newest one. Measured: 120 px off the bottom, 30 messages arrive, reopen lands
 * 5701 px up. Verbatim the report: "scrolled up a bunch and I need to scroll
 * down to the most recent message."
 *
 * So the two questions are split, and only the second is remembered:
 *
 *   CAUGHT UP  ⇔  the newest message is at least partly ON SCREEN.
 *
 * A caught-up reader opens at the newest message, however much arrived while
 * they were away — they had read to the end, so the end is where they belong. A
 * reader who is NOT caught up scrolled back past the newest message on purpose;
 * they keep their exact spot, anchored to the message they were reading, no
 * matter what arrives. Stated in messages rather than pixels, because "am I at
 * the end of the conversation" is a fact about the conversation, and pixels stop
 * meaning anything the moment the document grows.
 *
 * `caughtUp` readers keep the follow-new-messages behavior; the sid guards
 * staleness — a cleared/rotated session forgets the spot.
 *
 * Persistence is gated by `shouldPersistChatScroll`: a display:none hide
 * zeroes clientHeight and must NOT write ratio 0 / unpinned, or the next
 * open restores into older history. Older-history prepends use
 * `scrollTopAfterOlderPrepend` so pinned readers stay at the bottom instead
 * of being height-delta'd mid-log (which used to unpin via onScroll).
 *
 * Module map + debounced sessionStorage write-through (reloads keep it),
 * LRU-bounded so a long cockpit session that visits many panes doesn't grow
 * it forever (pane deletion has no client-side hook to evict on). Storage key
 * is versioned (`:v4` — v2 entries carry no anchor, and v3 entries carry
 * `pinned`, which named the 40 px live-follow threshold rather than "had read
 * to the end". Reading either would silently keep the behaviour this file
 * exists to retire — and a v3 entry is precisely a reader stranded mid-log,
 * so inheriting one would carry the bug across the fix that removes it).
 */
export interface ChatScrollMem {
  /**
   * Event id of the message under the viewport top, and how far its top sat
   * ABOVE that line (so normally <= 0). null when nothing was measurable —
   * then `ratio` is all we have. Always null for a caught-up reader: "the
   * newest message" is not a fixed message, and pinning it to one is the bug.
   */
  anchorId: string | null;
  anchorOffset: number;
  /** 0..1 fraction of (scrollHeight - clientHeight). Fallback only. */
  ratio: number;
  /**
   * Had the reader read to the END of the conversation when they left?
   *
   * NOT the component's `pinnedToBottom` (see the header): that one governs
   * live auto-scroll at a 40 px threshold, and persisting it made a single
   * wheel nudge park a reader in history forever.
   */
  caughtUp: boolean;
  sid: string | null;
}

const KEY = 'muxpad:chat-scroll:v4';
const MAX_ENTRIES = 50;

const mem: Map<string, ChatScrollMem> = (() => {
  try {
    const raw = sessionStorage.getItem(KEY);
    return new Map(raw ? (JSON.parse(raw) as [string, ChatScrollMem][]) : []);
  } catch {
    return new Map();
  }
})();

let flushTimer: number | undefined;

export function rememberChatScroll(paneId: string, m: ChatScrollMem): void {
  // Delete-then-set makes insertion order an LRU order.
  mem.delete(paneId);
  mem.set(paneId, m);
  while (mem.size > MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
  // Debounced write-through: scroll events fire per frame.
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify([...mem]));
    } catch {
      // quota / private mode — the in-memory map still covers this session
    }
  }, 250);
}

export function recallChatScroll(paneId: string): ChatScrollMem | null {
  const m = mem.get(paneId);
  // A non-finite ratio (an older format, or a divide-by-zero that escaped)
  // coerces to scrollTop 0 and dumps the reader at the TOP of the chat. Treat
  // it as no memory. The anchor fields are normalised rather than rejected —
  // an entry with a usable anchor and a junk offset is still worth honouring.
  if (!m || !Number.isFinite(m.ratio)) return null;
  return {
    ...m,
    anchorId: typeof m.anchorId === 'string' ? m.anchorId : null,
    anchorOffset: Number.isFinite(m.anchorOffset) ? m.anchorOffset : 0,
  };
}

/**
 * Whether an onScroll should write remembered position. Hidden faces use
 * `display:none`, which zeroes `clientHeight` (and often `scrollTop`) — if we
 * persist that, reopen restores ratio 0 and the reader lands in older history.
 * Inactive panes must not overwrite a good memory either.
 */
export function shouldPersistChatScroll(opts: {
  active: boolean;
  clientHeight: number;
}): boolean {
  return opts.active && opts.clientHeight >= 40;
}

/**
 * May a trusted scroll event WRITE the remembered position?
 *
 * ── THE THIRD CASE ───────────────────────────────────────────────────────────
 * The header above describes two kinds of reader, and the whole re-entry policy
 * is deciding between them: a CAUGHT-UP reader opens at the newest message, a
 * SCROLLED-BACK reader keeps their exact spot. Both are descriptions of where
 * someone was READING.
 *
 * A search jump is neither. It is an explicit, one-shot destination the user
 * asked for from somewhere else entirely — "take me to the message that says
 * X" — and it lands wherever that message happens to be, usually deep in
 * history. Left ungated, the jump's own scrollTop writes produce scroll events
 * like any other, and each one would record "parked at message X, not caught
 * up". The next ORDINARY open of that chat — a click on the tab tomorrow, with
 * no search involved — would then faithfully restore a reader who had read to
 * the end to a message from three weeks ago. That is the exact bug the
 * caught-up rule was introduced to kill, re-entering through a different door.
 *
 * So a jump records NOTHING, and whatever was remembered before the search
 * stands. A reader who was caught up is still caught up; one who was parked
 * mid-history is still parked there.
 *
 * The hold is released the moment the reader does something with the pane —
 * a wheel spin, a drag, dismissing the highlight — because at that point they
 * are no longer being shown a search result, they are reading, and where they
 * choose to be is exactly what the memory is for. Time does not release it:
 * a reader who studies the hit for two minutes and leaves has still not told us
 * anything about where they want to resume.
 */
export function shouldRememberPosition(opts: { searchJumpActive: boolean }): boolean {
  return !opts.searchJumpActive;
}

/**
 * After an older-history batch prepends, where should `scrollTop` land?
 * Pinned readers stay at the bottom (follow new messages). Unpinned readers
 * keep the same messages under the viewport via the classic height-delta
 * restore. Without the pinned branch, the height-delta lands mid-log and the
 * ensuing onScroll unpins — the "opens into older chat" bug on fill-viewport
 * pagination / cross-device first open.
 */
export function scrollTopAfterOlderPrepend(opts: {
  pinned: boolean;
  newScrollHeight: number;
  clientHeight: number;
  anchorHeight: number;
  anchorTop: number;
}): number {
  if (opts.pinned) {
    return maxScrollTop(opts.newScrollHeight, opts.clientHeight);
  }
  // CLAMPED. If clientHeight changed between capturing the anchor and
  // applying it (a composer resize, a viewport change), the raw arithmetic
  // can land outside the scrollable range. The browser would clamp the real
  // scrollTop but the caller still stamps the UNCLAMPED value as
  // `lastProgrammaticTop`, so the very next scroll event reads as "the
  // reader took control" — unpinning them mid-history for no reason.
  const raw = opts.newScrollHeight - opts.anchorHeight + opts.anchorTop;
  return Math.min(Math.max(0, raw), maxScrollTop(opts.newScrollHeight, opts.clientHeight));
}

/**
 * Where re-opening a chat lands: at the newest message, or back at the
 * remembered one? No memory → newest (fresh mount / another device).
 *
 * Reads `caughtUp`, NOT a pin: see the header. This is the whole re-entry
 * policy, and it is deliberately the only thing that decides it.
 */
export function opensAtNewest(mem: ChatScrollMem | null): boolean {
  return !mem || mem.caughtUp;
}

/**
 * Was the reader at the END of the conversation — i.e. is the newest message
 * at least partly on screen?
 *
 * `lastRowTop` is the newest anchored row's top relative to the scroll
 * viewport's top; null when there are no rows to measure (an empty chat, or a
 * hidden pane whose boxes have collapsed), in which case the caller's pin state
 * is the best available answer.
 *
 * A message-shaped question, on purpose. The alternative — "within N pixels of
 * the bottom" — cannot distinguish a reader who has read to the end from one
 * who happens to be near it, and the distance to the bottom is not even
 * constant at rest: the floating composer reserves ~130 px of list padding, so
 * a reader AT the bottom already sits that far from the last message's end.
 *
 * A message taller than the viewport is the interesting edge: a reader at its
 * top is caught up by this rule, and returning lands them at its end. That is
 * the right answer — they had scrolled back past nothing.
 */
export function readerIsCaughtUp(opts: {
  lastRowTop: number | null;
  clientHeight: number;
  nearBottom: boolean;
}): boolean {
  if (opts.lastRowTop === null) return opts.nearBottom;
  return opts.lastRowTop < opts.clientHeight;
}

/**
 * Whether a remembered sid may be applied against the currently rendered sid.
 * Soft match: either side unset is OK (hello hasn't bound yet / saved early).
 * Only a REAL mismatch (both set, different) blocks — /clear or resume.
 */
export function scrollMemorySidMatches(memSid: string | null, renderedSid: string | null): boolean {
  return !memSid || !renderedSid || memSid === renderedSid;
}

/** Max scrollTop for an element — browsers clamp assignments above this. */
export function maxScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * How long after a pane becomes visible its scroll events are ignored for
 * PIN/MEMORY purposes.
 *
 * A pane un-hidden from display:none delivers scroll events while its layout
 * is still settling: `clientHeight` is back but `scrollTop` may still be the
 * stale (or engine-zeroed) value, and the composer's height hasn't regrown.
 * The first such event used to be read as "the reader scrolled": it set
 * `userScrolled`, killed the settling restore, flipped `pinnedToBottom` to
 * false and wrote that to memory — so a chat stopped following new messages
 * while plainly visible, and stayed that way. That is what made the bug
 * STICKY rather than a one-off jump.
 *
 * Two animation frames is the shortest window that reliably spans the
 * relayout; we use a small wall-clock budget instead of counting frames so a
 * throttled background tab can't leave the window open forever.
 */
export const SHOW_SETTLE_MS = 250;

/**
 * How long a smooth `scrollTo` glide is suppressed for. The animation emits a
 * scroll event per frame, none of which is the reader: read as gestures they
 * would unpin the chat the "jump to latest" button just pinned, and persist a
 * mid-glide ratio if the pane is hidden before the glide finishes.
 */
export const SMOOTH_SCROLL_SETTLE_MS = 600;

/**
 * Should this scroll event be allowed to change pin state / scroll memory?
 *
 * `suppressedUntil` is a timestamp the component stamps when it starts moving
 * the scroll itself (a show transition, a smooth jump-to-bottom); 0 means
 * nothing is in flight. A REAL gesture clears it — distrusting scroll events
 * for a moment is right, distrusting the reader never is, so the component
 * zeroes this the instant a wheel/touch arrives.
 *
 * Pure so the rule is testable without a DOM: the component supplies clock
 * readings (monotonic ones — see performance.now at the call site).
 */
export function scrollEventIsTrustworthy(opts: {
  suppressedUntil: number;
  now: number;
}): boolean {
  return opts.now >= opts.suppressedUntil;
}

/**
 * Index of the first row still (at least partly) on screen: the first whose
 * BOTTOM is below the viewport top. That row is the one the reader's eye is
 * anchored to, and the only one whose identity survives the document changing
 * around it.
 *
 * Binary search, because this runs off scroll events and `bottomOf` costs a
 * `getBoundingClientRect` each — a linear scan over a few hundred rows would
 * be a per-frame layout tax on a chat that is doing nothing wrong. Rows are
 * in-flow siblings in document order, so their bottoms are monotonic.
 *
 * Returns `count` when every row is above the line (the reader is past the end
 * — only reachable transiently mid-relayout).
 */
export function firstVisibleRow(
  count: number,
  bottomOf: (i: number) => number,
  viewportTop: number,
): number {
  let lo = 0;
  let hi = count; // invariant: answer is in [lo, hi]
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > viewportTop) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Where `scrollTop` must land to put the anchored message back where it was.
 *
 * `rowTop` is the anchor row's current top relative to the viewport top;
 * `anchorOffset` is where it sat when we remembered it. The difference is
 * exactly how far the document has drifted under the reader, whatever caused
 * it — a prepended history batch, a thumbnail decoding above, a font settling.
 *
 * CLAMPED for the same reason `scrollTopAfterOlderPrepend` is: the caller
 * stamps the returned value as `lastProgrammaticTop`, and an out-of-range value
 * never equals the scrollTop the browser clamps to — so the next scroll event
 * would read as the reader taking control, and the restore loop would re-assign
 * (forcing a reflow) every frame for its whole window.
 */
export function scrollTopForAnchor(opts: {
  scrollTop: number;
  rowTop: number;
  anchorOffset: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const raw = opts.scrollTop + (opts.rowTop - opts.anchorOffset);
  return Math.min(Math.max(0, raw), maxScrollTop(opts.scrollHeight, opts.clientHeight));
}

/**
 * Where a search hit should sit in the viewport, as a fraction from the top.
 *
 * Not the top (a message flush against the viewport edge looks like it was
 * scrolled past, and there is no way to tell whether the conversation above it
 * is the reason you are here) and not the middle (which wastes the screen on a
 * long answer, pushing the rest of the message you came to read off the
 * bottom). A third of the way down leaves a line or two of the preceding turn
 * visible as context and still gives the message itself most of the screen.
 */
const SEARCH_HIT_VIEW_FRACTION = 1 / 3;

/**
 * Where `scrollTop` must land to bring a search hit into view.
 *
 * `hitTop` is the matched run's top relative to the scroll viewport's top —
 * the MARK, not the message, when there is one: a hit two thousand pixels down
 * a long assistant answer is not "brought into view" by putting the top of
 * that answer on screen.
 *
 * CLAMPED, for the reason every other target in this file is: the caller
 * stamps the result as `lastProgrammaticTop`, and a value the browser then
 * clamps would never equal the real scrollTop — so the very next scroll event
 * would read as the reader taking control.
 */
export function scrollTopForSearchHit(opts: {
  scrollTop: number;
  hitTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const raw = opts.scrollTop + opts.hitTop - opts.clientHeight * SEARCH_HIT_VIEW_FRACTION;
  return Math.min(Math.max(0, Math.round(raw)), maxScrollTop(opts.scrollHeight, opts.clientHeight));
}

/**
 * How long the jump-to-hit placement keeps re-asserting itself.
 *
 * Same problem the restore loop has, for the same reason: the document is
 * still settling when the target first renders (markdown commits, images
 * decode, older pages the seek asked for are still landing), so a one-shot
 * scroll drifts. Shorter than RESTORE_SETTLE_MS because by the time a jump
 * places anything the transcript is already loaded — this window only has to
 * cover the last of the layout. It ends early the instant the reader scrolls.
 */
export const SEARCH_JUMP_SETTLE_MS = 1200;

/**
 * How long a jump may go unresolved before we admit we cannot find it.
 *
 * The seek below is driven by arriving history, so a socket that never opens
 * (or a server with no `load-older` handler) would leave the reader on a chat
 * that looks like the search did nothing at all. This is the backstop that
 * turns that silence into a sentence.
 */
export const SEARCH_JUMP_DEADLINE_MS = 15_000;

/**
 * How many older-history pages a restore may request while hunting for the
 * remembered message.
 *
 * A fresh mount opens on the server's ~128 KB tail, so a reader who had paged
 * back through half a long conversation left an anchor that simply is not in
 * the document yet — and no arithmetic can conjure it. Paging back to find it
 * is the only honest answer, but it has to be bounded: each page is a socket
 * round trip and up to 128 KB, and a reader whose anchor was lost to a `/clear`
 * must not drag the whole transcript over the wire looking for it.
 *
 * Eight pages ≈ 1 MB, which covers "I scrolled back a few screens yesterday"
 * without ever approaching the tens of MB a long session's transcript reaches.
 * Past that the fallback ratio applies and the reader lands in the tail — the
 * old behaviour, which is a floor, not a regression.
 */
export const ANCHOR_SEEK_PAGE_BUDGET = 8;

/**
 * How long the settling restore keeps trying.
 *
 * The base window covers layout settling (composer regrowth, thumbnails). Two
 * things extend it rather than raising the base for every restore: a SEEK (each
 * page is a server round trip) and a document that isn't scrollable yet (a cold
 * mount whose transcript is still in flight — letting the window expire there
 * left an unpinned reader at scrollTop 0, i.e. as deep in history as the
 * document goes). Extensions are `max`, never assignment: assigning
 * `now + ANCHOR_SEEK_PAGE_MS` to a window that still had 2500ms on it would
 * SHORTEN a seeking restore, which is the opposite of the intent.
 *
 * `RESTORE_HARD_STOP_MS` is the ceiling on all of it: extensions must never
 * keep an animation-frame loop alive indefinitely. It sits just above the worst
 * case a full seek can legitimately need
 * (ANCHOR_SEEK_PAGE_BUDGET × ANCHOR_SEEK_PAGE_MS).
 */
export const RESTORE_SETTLE_MS = 2500;
export const ANCHOR_SEEK_PAGE_MS = 1500;
export const RESTORE_HARD_STOP_MS = 15_000;
