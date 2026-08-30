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
 * `pinned` readers keep the follow-new-messages behavior; the sid guards
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
 * is versioned (`:v3` — v2 entries carry no anchor, and reading them would
 * silently keep the ratio behaviour this file exists to retire).
 */
export interface ChatScrollMem {
  /**
   * Event id of the message under the viewport top, and how far its top sat
   * ABOVE that line (so normally <= 0). null when nothing was measurable —
   * then `ratio` is all we have.
   */
  anchorId: string | null;
  anchorOffset: number;
  /** 0..1 fraction of (scrollHeight - clientHeight). Fallback only. */
  ratio: number;
  pinned: boolean;
  sid: string | null;
}

const KEY = 'muxpad:chat-scroll:v3';
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

/** Pin policy on (re)activation: no memory → follow bottom (fresh / other device). */
export function pinnedFromMemory(mem: ChatScrollMem | null): boolean {
  return !mem || mem.pinned;
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
