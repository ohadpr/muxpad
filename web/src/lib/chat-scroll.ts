/**
 * REMEMBERED SCROLL POSITIONS for chat panes — the durable half of the scroll
 * mechanism. The live half is in chat-scroll-intent.ts (what to assert) and
 * chat-scroll-controller.ts (the one writer).
 *
 * A ChatPane loses its scroll constantly — a reload unmounts it, tab/pane/face
 * switches hide it with `display:none` (which zeroes `scrollTop`) — so returning
 * to a chat always snapped to the bottom.
 *
 * ── THE UNIT IS A MESSAGE. THERE IS NO RATIO. ────────────────────────────────
 * Position was once stored as a fraction of the scrollable range. A chat log
 * grows at BOTH ends — below when the agent keeps talking, ABOVE every time the
 * pager prepends a 128 KB batch — and a fraction only survives the second if the
 * content above the reader is fixed. Prepend `g` pixels and the honest target is
 * `R·range + g`; the ratio computes `R·(range + g)`, which is smaller for every
 * R < 1, so the reader is dragged back into older history, further each batch.
 *
 * It survived as "the fallback for when the anchored message isn't rendered",
 * and that is where the last catastrophes came from: a fresh mount opens on a
 * ~128 KB tail of a conversation that can run to tens of MB, so the fallback
 * applied a fraction of the WHOLE document to a sliver of it. Measured, 0.0363
 * of 185,753px (turn 40) became 0.0363 of the 13,044px tail and landed on turn
 * 296 — and because the result was recorded, each reopen consumed a larger
 * fraction: 4% → 13 → 21 → 28 → 42 → 53 → 62 → 66 → 72% over eight reloads, with
 * no fixed point short of the bottom.
 *
 * So the unit is `anchorId` (an event id, stable across prepends, appends,
 * dedupe and reconnects) plus `anchorOffset`, how far that message's top sat
 * above the viewport top. If the anchor is not loaded, SEEK it; if you cannot
 * find it, stay where you are. A floor is a floor; a guess is a walk.
 *
 * ── "CAUGHT UP", NOT "PINNED" ────────────────────────────────────────────────
 * Two questions on two timescales, and only the second is remembered. Whether
 * live output should scroll itself into view is a 40px question answered
 * continuously; whether the reader had finished the conversation is a 160px
 * question answered once, when they leave. Persisting the first as the second
 * meant one wheel notch (~120px, a single trackpad nudge to re-read the last
 * line) stored "parked on the newest message" — harmless until a ten-minute turn
 * landed thirty messages and the same anchor, faithfully restored, was 5701px
 * above the newest one. See `readerIsCaughtUp`.
 *
 * ── localStorage, NOT sessionStorage ─────────────────────────────────────────
 * "Whenever i open muxpad it resets my scroll position." Note the trigger:
 * OPENING THE APP. Three earlier rounds chased the position across doors that
 * keep the browsing context alive — a tab switch, a background, a reload — and
 * all tested clean. A cold open is the one door that does not: quit the PWA,
 * launch it again, and the new context's sessionStorage is empty BY
 * SPECIFICATION. Measured: parked at message 69, cold-opened at message 194.
 *
 * The key is NOT re-versioned across that move or across the removal of the
 * ratio. `:v4` names the SHAPE, and a v4 row is readable either way — bumping it
 * would throw away every reader's position once, to fix a bug about throwing
 * away every reader's position.
 *
 * Bounded two ways, because localStorage does not clean up after itself: an LRU
 * cap (pane deletion has no client-side hook to evict on) AND an age cutoff. A
 * pruned entry degrades to "no memory" → the newest message, never to a wrong
 * position. Only PARKED positions occupy those slots; a caught-up row is written
 * solely to tell the OTHER windows that the parked row they hold is finished
 * with (see `retired`), and is capped separately.
 */
export interface ChatScrollMem {
  /**
   * Event id of the message under the viewport top, and how far its top sat
   * ABOVE that line (so normally <= 0). null when nothing was measurable, and
   * always null for a caught-up reader: "the newest message" is not a fixed
   * message, and pinning it to one is the bug.
   *
   * There is deliberately no second field describing position. See the header:
   * a null anchor means "open at the newest message", not "fall back to
   * arithmetic".
   */
  anchorId: string | null;
  anchorOffset: number;
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

/**
 * How many PARKED positions the store keeps.
 *
 * Was 50, chosen when the cap was the only bound and every write — caught-up or
 * parked — competed for the same slots. Both premises are gone: the age cutoff
 * below is what actually stops the store growing without limit, and caught-up
 * rows are now capped separately (MAX_RETIRED), so these slots hold nothing but
 * positions a reader could still come back to.
 *
 * 50 was measurably too few for one cockpit. This machine runs ~37 chat panes
 * at once; every one of them parked, plus fourteen chats closed inside the
 * fortnight the age cutoff keeps, is 51 — and the row evicted is the
 * least-recently-WRITTEN one, i.e. the pane the reader has left alone longest,
 * which is exactly the position they are most likely to be coming back for.
 * Silently dropping it reads as "muxpad reset my scroll position" and is
 * indistinguishable from the bugs the rest of this file exists to fix.
 *
 * An entry serialises to roughly 120 bytes, so 200 of them is ~24 KB against a
 * 5 MB origin quota — the cap is not paying for anything scarce, and the flush
 * cost is a JSON parse of a list that is still small. The age cutoff remains
 * the real bound; this is a backstop against a pathological number of panes.
 */
const MAX_ENTRIES = 200;

/**
 * How many RETIREMENTS the store keeps — see `retired` for what one is.
 *
 * A separate budget on purpose. Retirements exist to be read by other windows
 * and by the next cold open; they are worth keeping around for a while and
 * worth nothing compared to a real parked position, so they must never compete
 * for the same slots. Caught-up chats are rewritten constantly (follow-bottom
 * re-pins produce a trusted scroll event per height change), so on a shared cap
 * they win every eviction and park nobody.
 *
 * 50 is generous for what it has to cover: a retirement only has to outlive the
 * stale parked row it cancels, in every window that still holds one. The age
 * cutoff expires it in the end, at which point the row it cancelled has expired
 * too — both were written inside the same fortnight — so an expiring retirement
 * cannot uncover a position it was hiding.
 */
const MAX_RETIRED = 50;

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

/**
 * Is this row a RETIREMENT — a record that the reader finished the
 * conversation — rather than a place they are coming back to?
 *
 * The same predicate `opensAtNewest` asks, over the stored shape. A retirement
 * and a missing row produce the identical answer for the reader; they differ
 * only in what they tell the OTHER windows, which is the whole reason the row
 * is written at all.
 */
function retired(m: ChatScrollMem): boolean {
  return m.caughtUp;
}

/**
 * Apply the two caps to a set of rows, newest-first within each.
 *
 * Parked positions and retirements are budgeted separately (see MAX_ENTRIES /
 * MAX_RETIRED), so a storm of caught-up traffic — or fifty of them inherited
 * from a build that stored them as ordinary entries — cannot evict a single
 * position a reader parked on purpose.
 *
 * Returned in write order, because that is the order the store is serialised in
 * and reading it back must be idempotent.
 */
function capped(rows: [string, StoredMem][]): [string, StoredMem][] {
  const byAge = [...rows].sort((a, b) => a[1].at - b[1].at);
  const parked = byAge.filter(([, m]) => !retired(m));
  if (parked.length <= MAX_ENTRIES && byAge.length - parked.length <= MAX_RETIRED) return byAge;
  return [
    ...parked.slice(-MAX_ENTRIES),
    ...byAge.filter(([, m]) => retired(m)).slice(-MAX_RETIRED),
  ].sort((a, b) => a[1].at - b[1].at);
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
  return new Map(capped(entries));
})();

let flushTimer: number | undefined;

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
      const ours = mem.get(id);
      if (ours && ours.at >= theirs.at) continue;
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
 * ── AND THE OTHER HALF: A DELETION IS NOT AN ABSENCE ────────────────────────
 * Merging by `at` answers "whose row is newer" — and for as long as retiring a
 * caught-up reader meant REMOVING the row, one of the two candidates had no row
 * to compare. Window B reading a conversation to the end deleted `p` from
 * storage; window A, still holding the parked row it loaded at boot, had no way
 * to tell that from "`p` was never stored". Its very next flush — of any pane at
 * all, or of nothing at all, since `pagehide` flushes unconditionally — put the
 * old position straight back, and the reader who had finished that conversation
 * was dropped back into the middle of it. Delivering every `storage` event
 * changed nothing: `adoptFromStorage` iterates the rows that ARE there, and the
 * row in question was the one that had gone.
 *
 * So a retirement is a ROW now (see `retired`), carrying the timestamp that
 * settles it exactly like an ordinary write: it out-ranks the older parked row
 * in every window that still holds one, and yields to a NEWER parked position
 * if the reader goes back and parks somewhere else. Absence means only what it
 * can honestly mean — "nobody has written this" — and no longer has to stand in
 * for a decision. Correct without the event, so it survives a window that was
 * frozen or discarded through the write.
 *
 * The caps are applied to the MERGED set and by write time, not by this window's
 * insertion order. The old form prepended foreign keys and then kept the tail,
 * so at a full store another window's newly created pane was dropped on the
 * floor and panes it had already evicted came back.
 */
function flush(): void {
  try {
    const now = Date.now();
    const merged = new Map(parseEntries(localStorage.getItem(KEY), now));
    for (const [id, ours] of mem) {
      const theirs = merged.get(id);
      if (!theirs || ours.at >= theirs.at) merged.set(id, ours);
    }
    localStorage.setItem(KEY, JSON.stringify(capped([...merged])));
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
  // ── DON'T SPEND A PARKED SLOT ON THE DEFAULT ──────────────────────────────
  // A caught-up reader is restored to the newest message, and so is a reader
  // with no memory at all (`opensAtNewest(null)`), so this row buys the READER
  // nothing. It is written anyway, and only for the other windows: it is what
  // retires the parked row they are still holding for this pane (see `flush`).
  // It is budgeted against MAX_RETIRED rather than MAX_ENTRIES so it cannot
  // cost a position anyone is coming back to.
  //
  // The eviction order is why that separation matters more than a headcount
  // suggests. Caught-up chats are rewritten constantly (follow-bottom re-pins
  // produce a trusted scroll event per height change), so they stay at the
  // fresh end; a PARKED chat is not rewritten at all while the reader is
  // elsewhere, so it ages to the front and is evicted first. On one shared cap
  // the store threw away exactly the positions it exists to keep, and the
  // symptom — "I scrolled up in that chat and later it dumped me at the
  // bottom" — is indistinguishable from the pin/caughtUp bug it was built to
  // fix.
  //
  // The anchor is DROPPED rather than carried along. A retirement says "the
  // reader finished this conversation"; a message id sitting next to that says
  // the opposite, and the only thing it could ever do is be restored by
  // something that reads one field and not the other.
  const row: StoredMem = m.caughtUp
    ? { anchorId: null, anchorOffset: 0, caughtUp: true, sid: m.sid, at: Date.now() }
    : { ...m, at: Date.now() };
  mem.set(paneId, row);
  // By WRITE TIME, not insertion order: `adoptFromStorage` can put another
  // window's row in at any point, and an adopted row's age is its `at`.
  const kept = capped([...mem]);
  if (kept.length !== mem.size) {
    mem.clear();
    for (const [id, v] of kept) mem.set(id, v);
  }
  // Debounced write-through: scroll events fire per frame. See
  // flushChatScrollNow for the half this cannot cover.
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, 250);
}

/**
 * What this window last knew about a pane's position.
 *
 * May return a RETIREMENT — `caughtUp: true`, no anchor — which `opensAtNewest`
 * answers exactly as it answers null. Callers must go through that predicate
 * rather than testing for null themselves; "there is no row" and "the reader
 * finished this conversation" are the same fact about re-entry, and only one of
 * them can be told to another window.
 */
export function recallChatScroll(paneId: string): ChatScrollMem | null {
  const m = mem.get(paneId);
  // Expiry is re-checked on READ, not just at load: a cockpit window stays open
  // for days, so the map in front of us can age past the cutoff without the
  // module ever re-initialising.
  if (m && Date.now() - m.at > MAX_AGE_MS) {
    mem.delete(paneId);
    return null;
  }
  // Normalised rather than rejected: an entry with a usable anchor and a junk
  // offset is still worth honouring, and an entry with NEITHER is the ordinary
  // "open at the newest message" row, not a corrupt one.
  //
  // This used to reject any entry whose `ratio` was not finite. That guard went
  // with the field — and it had to, because after the field was removed every
  // row this module writes would have failed it, i.e. the store would have
  // looked permanently empty and every pane would have opened at the bottom.
  if (!m) return null;
  return {
    caughtUp: !!m.caughtUp,
    sid: m.sid ?? null,
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
 * How far above the end of the rendered log the reader may sit and still count
 * as having finished it.
 *
 * Generous enough that nudging up a couple of wheel notches to re-read the last
 * line (Chromium: ~120 px each) doesn't park you in history forever — which is
 * the bug this rule was introduced to fix — and tight enough that scrolling away
 * on purpose is respected. Deliberately four times the live-follow threshold:
 * the two answer different questions on different timescales. See the note on
 * `readerIsCaughtUp`.
 */
const CAUGHT_UP_SLACK_PX = 160;

/**
 * Has the reader reached the END of the conversation?
 *
 * The one question re-entry consults. A caught-up reader opens at the newest
 * message, however much arrived while they were away; a reader who is not
 * caught up scrolled back on purpose and keeps their exact spot.
 *
 * ── IT ASKS ABOUT THE DOCUMENT, NOT ABOUT THE LAST MESSAGE ───────────────────
 * Two earlier versions of this asked a message-shaped question, and each was
 * introduced to fix the previous one's failure.
 *
 *   v1: "is the newest message's TOP on screen?" — which holds only while the
 *   newest message FITS. A Chat-mode reply with its action run above it, or an
 *   Agent-mode tool result, runs to several screens; a reader on the first
 *   screen of one was recorded caught up, so coming back dropped them at the END
 *   of the thing they were halfway through. Reported as "I come back to muxpad
 *   and it scrolls to the very bottom instead of my last position".
 *
 *   v2: "is the newest message's END on screen?" — right for that case, and
 *   wrong for its neighbour, because the newest MESSAGE is not the end of the
 *   DOCUMENT. Everything the live turn puts below it — the streaming preview,
 *   the optimistic user bubble, the question card, the queued strip — carries no
 *   `data-eid` and so is invisible to a rule that walks anchored rows. A reader
 *   who scrolled up to the end of the last committed message while three screens
 *   of streaming output sat below them measured `lastRowBottom ≈ 0` and was
 *   recorded CAUGHT UP: on re-entry they were taken to the newest message, which
 *   is content they had deliberately scrolled away from and never read.
 *
 * So the question is asked about the scroll range, which by construction
 * includes every one of those and the composer's reserve row: is there anything
 * below you that you have not seen? That answers v1's case for the same reason
 * v2 did — a reader on the first screen of a three-screen message has two
 * screens below them — and it answers v2's case, which no row-walk can.
 *
 * Note this is NOT the live-follow threshold wearing different clothes. That one
 * is 40 px and governs whether output scrolls itself into view while you watch;
 * this one is 160 px and governs where you land tomorrow. Same measurement,
 * different slack, different question — and persisting the first as the second is
 * the bug that stored "parked on the newest message" for one wheel notch and then
 * stranded the reader 5701 px up when a ten-minute turn landed.
 */
export function readerIsCaughtUp(opts: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  // A document too short to scroll has no end to be short of.
  if (opts.scrollHeight <= opts.clientHeight) return true;
  return opts.scrollHeight - opts.scrollTop - opts.clientHeight <= CAUGHT_UP_SLACK_PX;
}

/*
 * `retiredAnchorMemory` used to live here: when the settling restore gave up on
 * an anchor it could not reach, it wrote back whatever row the RATIO FALLBACK
 * had landed on, so the next open would be an ordinary one instead of spending
 * another eight pages on the same ghost.
 *
 * It is gone with the fallback, and nothing replaces it. Retirement existed only
 * to clean up after a guess; with nothing guessing, a seek that runs out of
 * budget simply leaves the record alone and the reader where the document
 * opened. The budget itself is what stops the pages being re-spent (see
 * `ScrollState.pages`, which survives a visibility flip and is reset only by a
 * fresh mount) — a counter, rather than a write-back that had to be gated on
 * `!hasMoreOlder` to avoid overwriting the reader's real parked spot with a row
 * chosen by arithmetic against a fraction of the conversation.
 *
 * Those two rules — "retire a dead anchor" and "never retire against a partial
 * document" — were each correct, and composing them is what produced the live
 * bug: a budget-exhausted seek in a conversation that still had history never
 * retired at all, so every tab switch re-spent the whole budget AND re-applied
 * the ratio against a document the previous runs had grown.
 */

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
 * Where `scrollTop` must land to put the anchored message back where it was.
 *
 * `rowTop` is the anchor row's current top relative to the viewport top;
 * `anchorOffset` is where it sat when we remembered it. The difference is
 * exactly how far the document has drifted under the reader, whatever caused
 * it — a prepended history batch, a thumbnail decoding above, a font settling.
 *
 * CLAMPED into the scrollable range: the caller
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
 * How long a jump may go unresolved before we admit we cannot find it.
 *
 * The seek below is driven by arriving history, so a socket that never opens
 * (or a server with no `load-older` handler) would leave the reader on a chat
 * that looks like the search did nothing at all. This is the backstop that
 * turns that silence into a sentence.
 */
export const SEARCH_JUMP_DEADLINE_MS = 15_000;

/**
 * Which action runs the reader had expanded, per pane.
 *
 * ── WHY THIS IS IN THE SCROLL FILE ───────────────────────────────────────────
 * Because it is a scroll bug. `expandedGroups` was plain component state, and a
 * sidebar tab switch unmounts the whole pane tree — so a run the reader had
 * opened came back COLLAPSED, and the offset into it (`anchorOffset`, measured
 * against the tall box) was replayed against a ~26px summary. Measured: a reader
 * 799px inside a 25-action run, reloaded, with the stored offset pushing them
 * 799px past a row that no longer had the height to hold it, which the range
 * clamp then pinned to the BOTTOM of the chat. Deterministic, not intermittent,
 * and a verbatim match for "I come back to muxpad and it scrolls to the very
 * bottom instead of my last position".
 *
 * `scrollTopForAnchor`'s row-height clamp turns that catastrophe into a lost
 * place: the offset is discarded and the reader lands on the run's top. This
 * removes the bug class instead — if the run is still open, the offset into it
 * still means what it meant.
 *
 * Same storage tier and same expiry as the position, because it is the same
 * fact: what the document looked like when the reader left it.
 */
const FOLDS_KEY = 'muxpad:chat-folds:v1';

function foldStore(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, string[]>)
      : {};
  } catch {
    return {};
  }
}

export function recallExpandedRuns(paneId: string): Set<string> {
  const v = foldStore()[paneId];
  return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
}

export function rememberExpandedRuns(paneId: string, ids: Set<string>): void {
  try {
    const all = foldStore();
    if (ids.size === 0) delete all[paneId];
    else all[paneId] = [...ids];
    // Bounded by the same argument the position store uses, and more cheaply:
    // a pane with no open runs has no row, so the common case costs nothing.
    const keys = Object.keys(all);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];
    localStorage.setItem(FOLDS_KEY, JSON.stringify(all));
  } catch {
    // quota / private mode — folds just do not persist
  }
}
