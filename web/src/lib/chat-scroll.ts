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
 * Module map + debounced sessionStorage write-through (reloads keep it),
 * LRU-bounded so a long cockpit session that visits many panes doesn't grow
 * it forever (pane deletion has no client-side hook to evict on).
 */
export interface ChatScrollMem {
  /** 0..1 fraction of (scrollHeight - clientHeight). */
  ratio: number;
  pinned: boolean;
  sid: string | null;
}

const KEY = 'muxpad:chat-scroll';
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
  return mem.get(paneId) ?? null;
}
