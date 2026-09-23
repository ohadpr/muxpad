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
 *   CAUGHT UP  ⇔  the END of the newest message is on screen (see
 *                 readerIsCaughtUp for why its end and not its start).
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
 * ── WHY localStorage, NOT sessionStorage ─────────────────────────────────────
 * "Whenever i open muxpad it resets my scroll position."
 *
 * Note the trigger: OPENING THE APP. The three rounds above all chased the
 * position across doors that keep the browsing context alive — a tab switch, a
 * background/foreground, a reload (F5 replaces the document, but the TAB, and
 * therefore its sessionStorage, is the same one). This store used to be
 * sessionStorage, and its own comment claimed "reloads keep it", which was
 * true. That is exactly why every previous round tested clean.
 *
 * A cold open is the one door that does not keep the context: quit the PWA,
 * close the window, launch muxpad again, and the new context's sessionStorage
 * is empty BY SPECIFICATION. Not degraded, not stale — absent. Every pane fell
 * back to its default, which for a reader parked in history reads exactly like
 * "it reset my scroll position". Measured on the real stack: parked at message
 * 69, cold-opened at message 194 (the bottom).
 *
 * So the memory outlives the browsing context, like every other per-device
 * preference here (settings, nav expansion, last-visited, and the terminal
 * pane's own scroll ratio in `pane-scroll.ts`, which has always been
 * localStorage).
 *
 * The key is NOT re-versioned for this. `:v4` names the SHAPE of an entry, and
 * the shape is unchanged — v2 entries carry no anchor and v3 entries carry
 * `pinned` (the 40 px live-follow threshold masquerading as "had read to the
 * end"), so inheriting either would carry a bug across the fix that removed it.
 * A v4 entry is the post-fix shape and inheriting one is exactly what we want:
 * the storage TIER changed, not the meaning. Bumping would instead throw away
 * every reader's position once, to fix a bug about throwing away every reader's
 * position — and would make the migration below unable to see what it migrates.
 *
 * Bounded two ways, because localStorage does not clean up after itself the way
 * a dying session used to: an LRU cap of 50 entries (pane deletion has no
 * client-side hook to evict on) AND an age cutoff, so a pane read once a
 * quarter ago cannot resurrect a position from a conversation that has since
 * been cleared. A pruned entry degrades to "no memory" → the newest message,
 * never to a wrong position.
 *
 * Only PARKED positions occupy those 50 slots. A caught-up reader is restored
 * to the newest message and so is a reader with no memory at all, so storing
 * one buys nothing and costs a slot — see `rememberChatScroll` for what that
 * cost measured out to on this machine.
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

/**
 * How long a remembered position stays worth restoring.
 *
 * The LRU cap alone was enough when the store died with the session. It is not
 * enough now: 50 entries persist indefinitely, and the panes they name can be
 * deleted, their sessions cleared, their anchored messages long since scrolled
 * out of any window the server will ever hand back. Two weeks is well past any
 * plausible "I was reading that, I'll come back to it" and short enough that a
 * pane you have not opened since last month simply opens at the newest message
 * — which is the correct default, not a reset.
 *
 * Staleness is a hygiene rule, not a correctness one: the sid guard already
 * blocks a rotated session, and an anchor that cannot be found inside
 * ANCHOR_SEEK_PAGE_BUDGET pages falls back to the tail. Nothing here can turn
 * an old entry into a WRONG position; the cutoff just stops us trying.
 */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * What actually goes in storage: the public memory plus WHEN it was written.
 *
 * `at` is stamped by `rememberChatScroll` rather than supplied by callers —
 * the component has no business knowing the store has an expiry policy, and a
 * field it had to remember to set is a field it would eventually forget.
 */
interface StoredMem extends ChatScrollMem {
  at: number;
}

/**
 * Parse a serialised store, dropping anything malformed or expired.
 *
 * Defensive per-entry rather than all-or-nothing: this blob now survives
 * upgrades indefinitely, so one bad entry must not cost the reader all fifty.
 */
function parseEntries(raw: string | null, now: number): [string, StoredMem][] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: [string, StoredMem][] = [];
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const m = entry[1] as (ChatScrollMem & { at?: unknown }) | null;
      if (!m || typeof m !== 'object') continue;
      // A missing `at` is an entry from before this file stamped one — i.e. one
      // inherited from sessionStorage, which BY CONSTRUCTION cannot be older
      // than the browsing context that just ended. Treat it as fresh. Reading
      // it as epoch 0 would expire the entire migration on arrival, so the
      // fix's first act would be the very reset it exists to prevent.
      const at = typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : now;
      if (now - at > MAX_AGE_MS) continue;
      out.push([entry[0], { ...m, at }]);
    }
    return out;
  } catch {
    return [];
  }
}

const mem: Map<string, StoredMem> = (() => {
  const now = Date.now();
  let entries: [string, StoredMem][] = [];
  try {
    entries = parseEntries(localStorage.getItem(KEY), now);
  } catch {
    // private mode / storage disabled — the in-memory map still covers this tab
  }
  // ── MIGRATION ───────────────────────────────────────────────────────────
  // Adopt whatever the sessionStorage era left in THIS tab, so shipping the
  // fix is not itself the last reset. Read-and-clear: once it is in the
  // durable store the session copy is only a second source of truth. Entries
  // localStorage already knows about win — they are the ones written by a
  // build that understood this store — and the legacy ones go in FRONT,
  // because insertion order here IS the LRU order and they are the older
  // writes.
  try {
    const legacy = sessionStorage.getItem(KEY);
    if (legacy) {
      sessionStorage.removeItem(KEY);
      const known = new Set(entries.map(([id]) => id));
      entries = [...parseEntries(legacy, now).filter(([id]) => !known.has(id)), ...entries];
    }
  } catch {
    // no sessionStorage to migrate from
  }
  return new Map(entries.slice(-MAX_ENTRIES));
})();

let flushTimer: number | undefined;

/**
 * Panes this window has deliberately FORGOTTEN, and when.
 *
 * A caught-up reader needs no stored row — `opensAtNewest(null)` and
 * `opensAtNewest({caughtUp: true})` are the same answer — so those writes are
 * dropped rather than given an LRU slot (see `rememberChatScroll`). Dropping
 * from `mem` is not enough on its own: `flush` merges what is already in
 * localStorage, so a row this window deleted would be read straight back in.
 * The timestamp is what keeps that honest across two windows: it out-ranks an
 * OLDER stored row and yields to a NEWER one, exactly like an ordinary write.
 */
const dropped = new Map<string, number>();

/**
 * Take in whatever another window has written since we last looked.
 *
 * Bound to the `storage` event, which fires in every OTHER window of the origin
 * on each write. Without it this window answers from a snapshot taken at
 * import: `recallChatScroll` reads `mem` and nothing else, so a pane the other
 * window has since moved restores to where it was at boot, and the next flush
 * writes that stale position back over the newer one.
 *
 * Deliberately NOT called from `recallChatScroll`: that runs on every scroll
 * event while a restore is holding its anchor, and a localStorage read plus a
 * 50-entry JSON parse per frame is not a price a scroll can pay. The `storage`
 * event covers the live case, and the import-time read covers everything
 * written while this window did not exist — between them there is no gap.
 */
function adoptFromStorage(): void {
  try {
    const now = Date.now();
    for (const [id, theirs] of parseEntries(localStorage.getItem(KEY), now)) {
      const gone = dropped.get(id);
      if (gone !== undefined && gone >= theirs.at) continue;
      const ours = mem.get(id);
      if (ours && ours.at >= theirs.at) continue;
      dropped.delete(id);
      mem.set(id, theirs);
    }
  } catch {
    // private mode — nothing to adopt
  }
}

/**
 * Write the map through to localStorage, MERGING by write time.
 *
 * ── TWO WINDOWS ─────────────────────────────────────────────────────────────
 * sessionStorage was per-tab, so this never came up. localStorage is shared by
 * every muxpad window on the origin, and each one serialises its WHOLE map —
 * so a naive `setItem([...mem])` from window B would delete window A's memory
 * for panes B has never even opened.
 *
 * This used to carry over only the keys it had never seen (`!mem.has(id)`), and
 * `mem` is filled AT IMPORT with the entire store. So "foreign" meant "created
 * after this window booted", and every key this window merely happened to load
 * was treated as its own forever — even for a chat it never opened. Window B
 * moving a position that window A had in its boot snapshot was silently undone
 * the next time A flushed anything at all. The comment above this function
 * claimed last-writer-wins for a pane BOTH windows have open; the code was
 * last-FLUSHER-wins for every pane either window had ever loaded.
 *
 * Now the comparison is the one the comment always described: `at` decides, per
 * key, and a window only overwrites a row it genuinely wrote more recently. For
 * a pane both windows really do have open, last writer still wins — there is no
 * better answer available, and both candidates are a position that reader
 * actually occupied, so the loser costs them a scroll and never a wrong belief.
 *
 * The cap is applied to the MERGED set and by write time, not by this window's
 * insertion order. The old form prepended foreign keys and then kept the tail,
 * so at a full store another window's newly created pane was dropped on the
 * floor and panes it had already evicted came back.
 */
function flush(): void {
  try {
    const now = Date.now();
    const merged = new Map(parseEntries(localStorage.getItem(KEY), now));
    for (const [id, when] of dropped) {
      const theirs = merged.get(id);
      if (!theirs || theirs.at <= when) merged.delete(id);
    }
    for (const [id, ours] of mem) {
      const theirs = merged.get(id);
      if (!theirs || ours.at >= theirs.at) merged.set(id, ours);
    }
    const entries = [...merged].sort((a, b) => a[1].at - b[1].at).slice(-MAX_ENTRIES);
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // quota / private mode — the in-memory map still covers this session
  }
}

/**
 * Write through NOW, cancelling the debounce.
 *
 * The 250ms debounce is right for a scroll storm — wheel and trackpad events
 * fire per frame, and every one of them calls `rememberChatScroll` — but it has
 * no answer for the browsing context ENDING inside the window. Worse, each
 * remember RESTARTS the timer, so a reader who scrolls to a message and quits
 * without pausing a quarter of a second never flushes ANY of that scroll
 * session. Cold open then finds nothing and opens at the newest message, which
 * is the same user-visible reset the move to localStorage existed to kill, just
 * through a smaller door.
 *
 * iOS makes it routine rather than a race: it freezes timers the moment the
 * page is backgrounded and may kill the WKWebView without ever running one.
 * `pagehide` is the event that does fire — the voice stack in this app already
 * knows that — and `visibilitychange` catches the app-switcher case that never
 * reaches `pagehide` at all.
 */
export function flushChatScrollNow(): void {
  if (typeof window !== 'undefined') window.clearTimeout(flushTimer);
  flushTimer = undefined;
  flush();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) adoptFromStorage();
  });
  window.addEventListener('pagehide', flushChatScrollNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChatScrollNow();
  });
}

export function rememberChatScroll(paneId: string, m: ChatScrollMem): void {
  if (m.caughtUp) {
    // ── DON'T SPEND A SLOT ON THE DEFAULT ────────────────────────────────────
    // A caught-up reader is restored to the newest message, and so is a reader
    // with no memory at all (`opensAtNewest(null)`). Storing one therefore buys
    // nothing — and costs an LRU slot, in a store capped at MAX_ENTRIES with a
    // cockpit that already runs ~37 live panes plus every chat closed in the
    // last fortnight.
    //
    // The eviction order made it worse than a headcount suggests. Caught-up
    // chats are rewritten constantly (follow-bottom re-pins produce a trusted
    // scroll event per height change), so they stay at the fresh end; a PARKED
    // chat is not rewritten at all while the reader is elsewhere, so it ages to
    // the front and is evicted first. The cap was throwing away exactly the
    // positions it exists to keep, and the symptom — "I scrolled up in that
    // chat and later it dumped me at the bottom" — is indistinguishable from
    // the pin/caughtUp bug this store was built to fix.
    mem.delete(paneId);
    dropped.set(paneId, Date.now());
  } else {
    dropped.delete(paneId);
    mem.set(paneId, { ...m, at: Date.now() });
    while (mem.size > MAX_ENTRIES) {
      // By WRITE TIME, not insertion order: `adoptFromStorage` can put another
      // window's row in at any point, and an adopted row's age is its `at`.
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, v] of mem) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      mem.delete(oldestId);
    }
  }
  // Debounced write-through: scroll events fire per frame. See
  // flushChatScrollNow for the half this cannot cover.
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, 250);
}

export function recallChatScroll(paneId: string): ChatScrollMem | null {
  const m = mem.get(paneId);
  // Expiry is re-checked on READ, not just at load: a cockpit window stays open
  // for days, so the map in front of us can age past the cutoff without the
  // module ever re-initialising.
  if (m && Date.now() - m.at > MAX_AGE_MS) {
    mem.delete(paneId);
    return null;
  }
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
  /**
   * `document.visibilityState === 'visible'`. Omitted = treat as visible.
   *
   * `active` only tracks muxpad's own hiding. iOS is documented in this
   * codebase as resetting overflow scroll on resume — that is the whole reason
   * `showEpoch` exists — and the native `scroll` event from that reset can land
   * before the restore effect has armed its suppression window. Persisting it
   * writes `ratio ≈ 0` and the oldest on-screen row over the reader's parked
   * message, and the restore then faithfully reproduces the corruption. A
   * document that is not visible has no reading position to record.
   */
  visible?: boolean;
}): boolean {
  return opts.active && opts.clientHeight >= 40 && opts.visible !== false;
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
 * May the settling RESTORE place the reader?
 *
 * The exact counterpart of `shouldRememberPosition`, and it has to be, because
 * the two are the read and write halves of one store. A jump deliberately
 * records nothing — so for as long as it holds, the remembered position
 * describes where the reader was BEFORE the search, which is by construction
 * somewhere else. Anything that re-asserts that memory while the jump is up
 * does not "restore" the reader; it drags them out of the result they asked
 * for and back into history.
 *
 * And something does re-assert it, on a schedule nobody chose: the restore
 * loop re-runs on every visibility transition (`showEpoch`) — a browser-tab
 * switch, an app backgrounding, a screen lock, a bfcache restore. None of
 * those is a gesture, none of them clears the jump (leaving the PANE does,
 * which is why a tab switch was never the reported case), and the placement
 * loop cannot push back because its own dependencies have not moved. Measured
 * on the real stack: parked at message 147, searched, landed on message 198,
 * backgrounded and returned — and was back at 147, a 14,696 px jump backwards,
 * with the highlight gone too (the dismissal observer sees the hit leave the
 * screen and concludes the reader scrolled away from it). Verbatim the report:
 * "muxpad keeps jumping back to scroll history randomly."
 *
 * So while a jump owns the scroll, the restore stands down. It is not a race
 * to be tuned — one of the two is answering a question the reader asked thirty
 * seconds ago, and the other is answering one they asked before that.
 *
 * The hold is released by exactly the things that release it for the memory (a
 * wheel, a finger, Escape, leaving the pane, the hit scrolling away), and the
 * very next restore is ordinary again.
 */
export function shouldRestorePosition(opts: { searchJumpActive: boolean }): boolean {
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
 * How far past the bottom of the viewport the newest message's END may sit
 * while the reader still counts as caught up.
 *
 * At rest this distance is NEGATIVE — the floating composer reserves ~130 px of
 * list padding below the last message — so the budget is really "a couple of
 * wheel notches up from the bottom" (Chromium: ~120 px each). Generous enough
 * that nudging up to re-read the last line doesn't park you in history forever,
 * which is the bug the message-shaped rule was introduced to fix; tight enough
 * that scrolling away on purpose is respected.
 */
const CAUGHT_UP_SLACK_PX = 160;

/**
 * Was the reader at the END of the conversation?
 *
 * `lastRowBottom` is the newest anchored row's BOTTOM relative to the scroll
 * viewport's top; null when there are no rows to measure (an empty chat, or a
 * hidden pane whose boxes have collapsed), in which case the caller's pin state
 * is the best available answer.
 *
 * A message-shaped question, on purpose. The alternative — "within N pixels of
 * the document bottom" — cannot distinguish a reader who has read to the end
 * from one who happens to be near it, and the distance to the bottom is not even
 * constant at rest: see CAUGHT_UP_SLACK_PX.
 *
 * ── WHY THE BOTTOM AND NOT THE TOP ───────────────────────────────────────────
 * This used to ask whether the newest message's TOP was on screen, on the
 * reasoning that a reader who can see it "had scrolled back past nothing". That
 * holds only while the newest message FITS. It routinely does not: a Chat-mode
 * reply with its action run folded above it, or an Agent-mode tool result, runs
 * to several screens. A reader on the first screen of one had their position
 * recorded as caught up, and re-entry is defined as "open at the newest
 * message" — so coming back dropped them at the END of the thing they were
 * halfway through, composer-ready, with no way back to their place. Reported as
 * "I come back to muxpad and it scrolls to the very bottom instead of my last
 * position".
 *
 * Measuring the END answers the question that was always meant: has the reader
 * actually reached the end of the newest message, not merely watched it begin.
 * A tall message now keeps its anchor (the row under the viewport top, with the
 * offset into it), which is exactly what the anchor was built to carry.
 */
export function readerIsCaughtUp(opts: {
  lastRowBottom: number | null;
  clientHeight: number;
  nearBottom: boolean;
}): boolean {
  if (opts.lastRowBottom === null) return opts.nearBottom;
  return opts.lastRowBottom - opts.clientHeight <= CAUGHT_UP_SLACK_PX;
}

/**
 * The memory that replaces a goal the settling restore could not reach.
 *
 * ── RETIRING A DEAD ANCHOR ───────────────────────────────────────────────────
 * The restore holds the stored anchor untouched while it is still seeking the
 * message it names — that hold is the only thing stopping the loop's own
 * scrollTop writes from overwriting the reader's parked spot. But when the seek
 * gives up, the store is still naming a message that is NOT COMING BACK, and
 * nothing else corrects it: the loop has usually converged and stopped writing
 * by then, so no further scroll event is coming.
 *
 * The cost is paid on every later visibility transition. The seek budget is a
 * local of the restore effect, and that effect re-runs on each of them — a
 * browser-tab switch, an iOS backgrounding, a screen unlock — so every flip
 * spends another eight `load-older` round trips on the same ghost, and each
 * re-run applies the remembered ratio against a document the previous re-runs
 * grew. That is the R·(range + g) walk this file's header calls catastrophic,
 * once per tab switch.
 *
 * So the loop hands over whatever it actually settled on. That row is a REAL
 * one — `captureAnchor` read it off the document — so the next restore is an
 * ordinary, instant one. `caughtUp` is MEASURED rather than assumed false: if
 * the fallback left the reader at the end of the log, saying so is what stops
 * the next open from pinning them to a message that is no longer the newest.
 */
export function retiredAnchorMemory(opts: {
  /** Where the loop settled, from `captureAnchor`. null → nothing anchorable. */
  live: { anchorId: string; anchorOffset: number } | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The newest anchored row's bottom, viewport-relative. null → none. */
  lastRowBottom: number | null;
  sid: string | null;
}): ChatScrollMem {
  const range = Math.max(1, maxScrollTop(opts.scrollHeight, opts.clientHeight));
  const nearBottom = opts.scrollHeight - opts.scrollTop - opts.clientHeight < 40;
  return {
    anchorId: opts.live?.anchorId ?? null,
    anchorOffset: opts.live?.anchorOffset ?? 0,
    // Clamped for the same reason every other stored ratio is: iOS rubber-band
    // reports a scrollTop outside the range, and a ratio outside [0,1] restores
    // to a target the browser then clamps, leaving the loop re-assigning it.
    ratio: Math.min(Math.max(0, opts.scrollTop / range), 1),
    caughtUp: readerIsCaughtUp({
      lastRowBottom: opts.lastRowBottom,
      clientHeight: opts.clientHeight,
      nearBottom,
    }),
    sid: opts.sid,
  };
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
 * Did the READER move, or did the document move under them?
 *
 * A scroll event whose position differs from the last programmatic target used
 * to be, on its own, proof that the reader took control. It is not, because the
 * browser's own scroll anchoring writes `scrollTop` during layout — paying an
 * unpinned reader for content that grew above them — and that write dispatches
 * an ordinary scroll event. Nothing can stamp the target for it: the engine
 * does it, not us. Measured in headless Chromium: the reader's row did not move
 * a pixel and the "reader took control" flag flipped true.
 *
 * That flag kills the settling restore, whose entire job is to hold a place
 * WHILE the document settles — late-decoding images, the fill-viewport pager,
 * the anchor seek's own prepended batches. All of those resize the content, so
 * the restore was being killed by the very conditions it exists for.
 *
 * An anchoring adjustment can only occur when the scrollable content RESIZED,
 * so that is the discriminator. On a resize the motion is attributed to layout
 * and the caller re-baselines its target to the new position. A real gesture
 * that happens to land mid-resize is not lost: wheel and touchmove are observed
 * directly and set the flag without consulting this at all.
 */
export function scrollMotionIsTheReader(opts: {
  /** Did `scrollHeight` change since the previous scroll event? */
  resized: boolean;
  scrollTop: number;
  lastProgrammaticTop: number;
}): boolean {
  if (opts.resized) return false;
  return Math.abs(opts.scrollTop - opts.lastProgrammaticTop) > 1;
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
  /** The anchored row's CURRENT height. Omitted → no clamp (callers that have
   *  not measured it; the old, unclamped behaviour). */
  rowHeight?: number | undefined;
}): number {
  // ── The offset has to still FIT THE ROW ──────────────────────────────────
  // `anchorOffset` is how far the row's top sat above the viewport top, so its
  // magnitude can never honestly exceed the row's own height — past that the
  // row is entirely off screen and would not have been the anchor. It is
  // replayed against the row as it is NOW, and the row routinely shrinks in
  // between: `expandedGroups` is plain component state, so an action run the
  // reader had expanded collapses to its ~44px summary on every remount (a
  // sidebar tab switch unmounts the pane tree) and on every reload.
  //
  // Unclamped, a reader 1800px deep inside a 3000px run came back with
  // `anchorOffset: -1800` replayed against 44px: target 4420 where the honest
  // answer was 2620, which the range clamp below then pinned to the BOTTOM of
  // the chat. Deterministic, not intermittent, and a verbatim match for "I come
  // back to muxpad and it scrolls to the very bottom instead of my last
  // position". Unlike a late-loading image — which grows back, letting the
  // settling loop re-converge — a collapsed run never returns, so the loop
  // re-asserted the same wrong target every frame for the whole window.
  //
  // An offset that cannot fit is DISCARDED rather than squeezed to the row's
  // edge: squeezing lands the reader just past a row they never finished, while
  // discarding puts its top under their eyes — the most honest answer available
  // once the thing they were reading is gone. An offset that still fits is left
  // exactly alone.
  const stale = opts.rowHeight !== undefined && -opts.anchorOffset > opts.rowHeight;
  const offset = stale ? 0 : opts.anchorOffset;
  const raw = opts.scrollTop + (opts.rowTop - offset);
  return Math.min(Math.max(0, raw), maxScrollTop(opts.scrollHeight, opts.clientHeight));
}

/**
 * Where `scrollTop` must land when a FOLD closes under the reader's feet.
 *
 * ── THE FOURTH WAY TO LOSE SOMEONE'S PLACE ───────────────────────────────────
 * The three mechanisms this file already fights — a persisted nudge, a lost
 * store, a restore overruling a jump — are all about which position we choose.
 * This one is about the document changing height ABOVE the reader with nobody
 * paying for it, which is the same shape as an older-history prepend and had no
 * equivalent of `scrollTopAfterOlderPrepend`.
 *
 * A search can land inside a COLLAPSED action run, so ChatPane forces that run
 * open around the highlight (a highlight nobody can see is no highlight). The
 * force is deliberately not written into `expandedGroups`, so the run snaps
 * shut again when the highlight is dismissed — and the signal for dismissal is
 * an IntersectionObserver firing when the hit LEAVES THE SCREEN. Put those
 * together and the common case is exact: the reader reads on past the hit, the
 * hit scrolls off the top, and the run — now above them, off screen — collapses
 * by its whole expanded height while they are mid-sentence.
 *
 * Measured on the real stack (Chromium, 300-turn transcript): a jump into a
 * folded run opened it to 456 px; scrolling 1200 px onward moved a probe row
 * from +682 to −948 instead of −518, and `scrollHeight` fell 26898 → 26468. A
 * 430 px leap, unasked for, from an ordinary scroll. Real Chat-mode runs hold
 * several scratchpad blocks, so the leap scales with them.
 *
 * So the run still snaps shut — the chat returns to its resting shape, which is
 * what that decision is for — and the collapse is paid for here, in the one
 * currency that keeps a reader still: the row under their eyes goes back where
 * it was.
 *
 * `anchorRowTop` is that row's current top relative to the viewport, measured
 * AFTER the collapse; null when it can't be measured (nothing anchorable, a
 * hidden pane), and then the honest answer is to leave the scroll alone rather
 * than guess. A PINNED reader is not re-anchored either: their anchor is the
 * bottom, the re-pin observer already holds it, and two owners of one scroll
 * position is how the last three of these started.
 *
 * Returns null for "don't touch it", never a fabricated target — and the target
 * it does return is clamped for the reason every other one in this file is: the
 * caller stamps it as `lastProgrammaticTop`, and a value the browser clamps
 * would read as the reader taking control on the very next event.
 */
export function scrollTopAfterFoldChange(opts: {
  pinned: boolean;
  anchorRowTop: number | null;
  anchorOffset: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number | null {
  if (opts.pinned || opts.anchorRowTop === null) return null;
  return scrollTopForAnchor({
    scrollTop: opts.scrollTop,
    rowTop: opts.anchorRowTop,
    anchorOffset: opts.anchorOffset,
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
  });
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
