/**
 * Remembered scroll positions for chat panes. A ChatPane loses its scroll
 * constantly — tab navigation unmounts it, and same-tab pane/face switches
 * hide it with display:none (which zeroes scrollTop) — so returning to a
 * chat always snapped to the bottom.
 *
 * Position is a RATIO of the scrollable range, not an absolute scrollTop:
 * content height can change while the reader is away (lazy-loading
 * attachment thumbnails especially), and an absolute offset then lands on
 * the wrong message; a ratio degrades proportionally. `pinned` readers keep
 * the follow-new-messages behavior; the sid guards staleness — a cleared/
 * rotated session forgets the spot.
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
 * is versioned (`:v2`) so a one-time wipe clears pre-fix corrupt entries
 * (ratio 0 / unpinned written while display:none).
 */
export interface ChatScrollMem {
  /** 0..1 fraction of (scrollHeight - clientHeight). */
  ratio: number;
  pinned: boolean;
  sid: string | null;
}

const KEY = 'muxpad:chat-scroll:v2';
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
  // Entries persisted by the earlier absolute-top format (same storage key)
  // have no finite ratio — NaN scrollTop coerces to 0 and dumps the reader
  // at the TOP of the chat. Treat them as no memory.
  if (!m || !Number.isFinite(m.ratio)) return null;
  return m;
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
