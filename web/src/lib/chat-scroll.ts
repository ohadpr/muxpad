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
    return Math.max(0, opts.newScrollHeight - opts.clientHeight);
  }
  return opts.newScrollHeight - opts.anchorHeight + opts.anchorTop;
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
export function scrollMemorySidMatches(
  memSid: string | null,
  renderedSid: string | null,
): boolean {
  return !memSid || !renderedSid || memSid === renderedSid;
}

/** Max scrollTop for an element — browsers clamp assignments above this. */
export function maxScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}
