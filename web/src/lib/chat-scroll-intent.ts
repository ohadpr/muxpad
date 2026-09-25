/**
 * WHERE THE CHAT SCROLL SHOULD BE — the whole decision, as data.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * The mechanism this replaces had twelve refs and eleven places that assigned
 * `scrollTop`, and every recent bug was the same shape: two owners disagreed
 * about one number, or a flag meant something subtly different to the code that
 * set it and the code that read it. Counted at the time of the rewrite, twelve
 * of `chat-scroll.ts`'s twenty-four exports and twelve of ChatPane's twenty
 * scroll refs existed to answer ONE question — "was that scroll event us or the
 * reader?" — and that question only existed because there were eleven writers.
 *
 * So: one value says where the scroll should be, one reducer changes it, one
 * function turns it into a number, and one function answers the question above.
 * Nothing here touches the DOM, so all four are unit-testable without a layout
 * engine — which matters because the previous design's ordering bugs were
 * invisible to jsdom and therefore invisible to the suite. (Mutating
 * `scrollTop < 240` to `< -1` — older history can never page in — left 1013
 * tests passing.)
 *
 * ── THE INTENT, AND WHY "NOTHING" IS A VALUE ─────────────────────────────────
 * `{ at: 'nothing' }` is the most important case in this file. It means "we do
 * not know where the reader belongs yet" — the transcript has not arrived, or
 * the message they parked on is older than the loaded window and has to be paged
 * back in first.
 *
 * The old design had no way to say that, so it guessed: it stored position as a
 * RATIO of the scrollable range and applied it whenever the anchored message was
 * missing. A ratio is a fraction of the document it was measured in, and a fresh
 * mount opens on a ~128 KB tail of a conversation that may be tens of MB — so
 * 0.0363 of a 185,753 px document (turn 40) became 0.0363 of the 13,044 px tail
 * and landed the reader on turn 296, the opposite end of the chat. Worse, the
 * guess was re-recorded, so each reopen consumed a slightly larger ratio and
 * walked further down: measured across eight reloads of one parked chat,
 * 4 % → 13 → 21 → 28 → 42 → 53 → 62 → 66 → 72 %, with no fixed point short of
 * the bottom.
 *
 * `'nothing'` is what the ratio was papering over. An honest "we do not know"
 * leaves the reader exactly where the document opened, which is a floor; a guess
 * puts them somewhere they have never been, which is a walk.
 */
import { maxScrollTop, scrollTopForAnchor, scrollTopForSearchHit } from './chat-scroll';
import type { ChatScrollMem } from './chat-scroll';

/** A message and how far its top sat above the viewport top (normally <= 0). */
export interface Anchor {
  id: string;
  offset: number;
}

/**
 * Where the scroll should be right now. There is no fourth kind of target.
 *
 * `hit` is a search destination rather than a reading position, and it is a
 * separate case because it answers to a different rule in two ways: it places
 * the MARK a third of the way down the viewport (not a row's top at a
 * remembered offset), and it is never written to the store. The old design
 * expressed that second half as a pair of predicates plus a hold flag
 * (`shouldRememberPosition` / `shouldRestorePosition` / `searchJumpHold`), all
 * three of which existed to stop OTHER owners of the scroll from fighting the
 * jump. With one owner it is a value: see `recordFor`, which returns null for
 * it, and `next`, where a `shown` input declines to overwrite it.
 */
export type ScrollIntent =
  | { at: 'end' }
  | { at: 'row'; id: string; offset: number }
  | { at: 'hit'; id: string }
  | { at: 'nothing' };

/**
 * The state machine's whole state. Four fields, and each one means exactly one
 * thing — which is the property the flag it replaces did not have.
 *
 * `userScrolled`, the flag this design most deliberately does not have, meant
 * three things at once: the settling restore's kill switch, "the reader is
 * scrolling", and "the reader has scrolled at some point this visit". It was
 * sticky for the whole visit, so one wheel notch disarmed the guard that keeps a
 * chat following its own output — measured 0/3 on a thumbnail burst after a
 * scroll-up-and-back, and 1/3 after tapping "jump to latest", which set the flag
 * deliberately. Nothing below is sticky except `pages`, which is a budget and
 * says so.
 */
export interface ScrollState {
  intent: ScrollIntent;
  /**
   * Pages of older history spent this VISIT trying to load `intent`'s row.
   *
   * Survives a `shown` — deliberately. The old seek counter was a local of the
   * restore effect, and the effect re-ran on every visibility transition, so a
   * browser-tab switch, an iOS backgrounding or a screen unlock each spent
   * another eight `load-older` round trips (~1 MB) hunting the same unreachable
   * message. Only `mounted` resets it.
   */
  pages: number;
  /**
   * Have we applied an intent since this pane became visible?
   *
   * The one causal gate in the mechanism, and the only survivor of six
   * wall-clock suppression windows (250 / 600 / 1200 / 1500 / 2500 / 15000 ms)
   * that used to decide intent between them. It exists for one measured case:
   * iOS resumes a WKWebView by resetting overflow scroll, and the native
   * `scroll` event from that reset can arrive before any React state update
   * lands. No geometry test can tell that event from a reader flicking to the
   * top — `clientHeight` is back and `scrollTop` is honestly 0 — so the
   * discriminator needs to know whether we have had a chance to place anyone
   * yet. Causal, not timed: set by applying, cleared by becoming visible.
   */
  placed: boolean;
}

export const IDLE_STATE: ScrollState = { intent: { at: 'nothing' }, pages: 0, placed: false };

/**
 * Everything that can change where the scroll should be.
 *
 * Nine, and the list is closed — that is the point of writing them down. Seven
 * are things that happen to the reader or the pane; `sought` and `applied` are
 * the two pieces of bookkeeping the other seven imply.
 *
 * Note what is NOT here: "a scroll event arrived", "the document changed
 * height", "some time passed". A height change does not change where the reader
 * belongs — it changes what `scrollTop` has to be to put them there, which is
 * `targetFor`'s job and is recomputed from live geometry every time. That
 * separation is why this design needs no settling loop: the old one polled for
 * "has the document finished changing?" with an animation-frame loop and a
 * 2500 ms fuse extended per page and capped at 15 s, when every event it was
 * waiting for — an image decoding, the composer regrowing, a history page
 * landing, a font settling — already fires a ResizeObserver notification.
 */
export type ScrollInput =
  /** A fresh pane. Forget the budget; nothing has been placed. */
  | { t: 'mounted' }
  /**
   * The pane became visible: a face/tab switch, a browser-tab switch, an iOS
   * resume, a bfcache restore. `mem` is what the store remembers, already
   * sid-checked by the caller (a real mismatch must arrive as null — it
   * describes a conversation that no longer exists).
   */
  | { t: 'shown'; mem: ChatScrollMem | null }
  /** The pane was hidden. Keep the intent; we have to re-place on return. */
  | { t: 'hidden' }
  /**
   * The reader moved the scroll themselves, by any device. `here` is the row
   * under the viewport top now; `atEnd` is whether they are within the
   * follow-me threshold of the document bottom.
   */
  | { t: 'reader-moved'; here: Anchor | null; atEnd: boolean }
  /** They tapped "jump to latest" — the one gesture that means "follow again". */
  | { t: 'jump-to-latest' }
  /**
   * They tapped a fold header. `offset` is where that header sat when they
   * tapped it, so it goes back there rather than being pushed off the top by a
   * re-pin — measured on the old design, a 1500 px expansion moved the tapped
   * header from +272 to −1228 while the reply below it did not move at all,
   * i.e. tapping "12 actions" visibly did nothing.
   */
  | { t: 'fold-toggled'; id: string; offset: number }
  /** A search result opened this pane, or superseded the last one. */
  | { t: 'search-jump'; id: string }
  /** The highlight was dismissed; the reader owns the scroll again. */
  | { t: 'search-cleared'; here: Anchor | null; atEnd: boolean }
  /** A `load-older` request actually went out (see `pages`). */
  | { t: 'sought' }
  /**
   * `place()` has READ THE LAYOUT — whether or not it had anything to assert.
   *
   * Deliberately not "applied". The gate this opens (`placed`) exists for one
   * case: an iOS resume fires a scroll event reporting 0 that no geometry test
   * can tell from a reader flicking to the top, so the discriminator has to know
   * whether we have had a look yet. That is a question about US, not about the
   * reader — and a pane whose intent is `{ at: 'nothing' }` has still been
   * looked at.
   *
   * Setting it only when a target was computed made IDLE an ABSORBING state:
   * while we did not know where the reader belonged, every scroll event read as
   * layout, so the reader could not tell us. Found in a browser, behind a green
   * unit suite — parking stored nothing, the pager saw no FOLLOWING reader and
   * paged the entire history, and a burst left the reader 2,640px short with
   * zero writes. One missing transition, three headline failures.
   */
  | { t: 'measured' };

/**
 * How many older-history pages one visit may spend hunting a remembered
 * message.
 *
 * A fresh mount opens on the server's ~128 KB tail, so a reader who had paged
 * back through half a long conversation left an anchor that simply is not in the
 * document yet, and no arithmetic can conjure it (see the header). Paging back
 * is the only honest answer, and it has to be bounded: each page is a socket
 * round trip of up to 128 KB, and a reader whose anchor was lost to a `/clear`
 * must not drag the whole transcript over the wire looking for it.
 *
 * Eight pages ≈ 1 MB, which covers "I scrolled back a few screens yesterday"
 * without approaching the tens of MB a long session reaches. Past that the
 * reader stays where the document opened — the documented floor.
 */
export const SEEK_PAGE_BUDGET = 8;

/**
 * The state machine. Total over `ScrollInput`, pure, and the only thing that
 * changes where the reader belongs.
 */
export function next(state: ScrollState, input: ScrollInput): ScrollState {
  switch (input.t) {
    case 'mounted':
      return IDLE_STATE;

    case 'hidden':
      // Keep `intent` — a hidden pane loses its scrollTop and the reader has to
      // be put back on return — but nothing is placed any more.
      return { ...state, placed: false };

    case 'shown': {
      // A live search hit OWNS the scroll, and the store cannot describe it:
      // nothing is recorded while a hit is up, so what is remembered is where
      // the reader was BEFORE they searched. Re-asserting it here does not
      // "restore" them, it drags them out of the result they asked for and back
      // into history — and this input fires on every visibility flip, which is
      // not a gesture and does not dismiss a highlight. Measured on the old
      // design: parked at message 147, searched to 198, backgrounded, returned
      // to 147 — a 14,696 px jump backwards, with the highlight gone too.
      if (state.intent.at === 'hit') return { ...state, placed: false };
      return { ...state, intent: intentFor(input.mem), placed: false };
    }

    case 'reader-moved':
    case 'search-cleared':
      // The reader is the authority on where they belong, so this ends a seek
      // (the budget is not reset — that would let a flip-flopping reader re-spend
      // it) and supersedes a hit.
      return {
        ...state,
        intent: input.atEnd
          ? { at: 'end' }
          : input.here
            ? { at: 'row', id: input.here.id, offset: input.here.offset }
            : // Nothing anchorable and not at the end: only reachable transiently
              // mid-relayout. Don't invent a target.
              { at: 'nothing' },
        placed: true,
      };

    case 'jump-to-latest':
      return { ...state, intent: { at: 'end' }, placed: true };

    case 'fold-toggled':
      return { ...state, intent: { at: 'row', id: input.id, offset: input.offset }, placed: true };

    case 'search-jump':
      // A new jump gets a fresh budget: it is a destination the reader asked for
      // just now, and refusing to page for it because an earlier restore spent
      // the pages would make the search silently do nothing.
      return { intent: { at: 'hit', id: input.id }, pages: 0, placed: false };

    case 'sought':
      return { ...state, pages: state.pages + 1 };

    case 'measured':
      return state.placed ? state : { ...state, placed: true };
  }
}

/**
 * Where a remembered position says the reader belongs.
 *
 * Reads `caughtUp` and nothing else. A caught-up reader opens at the newest
 * message however much arrived while they were away — they had read to the end,
 * so the end is where they belong — and a reader with no memory at all gets the
 * same answer, which is why a caught-up row buys the READER nothing and is
 * stored only to tell other windows the parked row they hold is finished with.
 *
 * Deliberately NOT the live-follow pin. That flag's threshold is 40 px, because
 * auto-scrolling someone who nudged up a line is obnoxious; persisting it as the
 * re-entry policy meant one wheel notch (~120 px, a single trackpad nudge to
 * re-read the last line) stored "parked on the newest message", and then a
 * ten-minute turn landed thirty messages and the same anchor — faithfully,
 * exactly restored — was 5701 px above the newest one.
 */
export function intentFor(mem: ChatScrollMem | null): ScrollIntent {
  if (!mem || mem.caughtUp) return { at: 'end' };
  if (!mem.anchorId) return { at: 'end' };
  return { at: 'row', id: mem.anchorId, offset: mem.anchorOffset };
}

/**
 * The four states of the brief's machine, derived rather than stored.
 *
 * Derived on purpose: a stored phase is a fifth thing that can disagree with the
 * other four. `rowLoaded` is the only thing the caller has to look up, and it is
 * the one fact that distinguishes "holding a message" from "hunting one".
 */
type ScrollPhase = 'FOLLOWING' | 'ANCHORED' | 'SEEKING' | 'IDLE';

export function phase(
  state: ScrollState,
  opts: { rowLoaded: boolean; hasMoreOlder: boolean },
): ScrollPhase {
  const { intent } = state;
  if (intent.at === 'end') return 'FOLLOWING';
  if (intent.at === 'nothing') return 'IDLE';
  if (opts.rowLoaded) return 'ANCHORED';
  return canSeek(state, opts) ? 'SEEKING' : 'IDLE';
}

/**
 * May we ask for another page of history to reach the current intent?
 *
 * The budget is spent in REQUESTS, not attempts — see `sought`. `requestOlder`
 * no-ops on a socket that is not open yet (a chat opened while the reconnect
 * backoff is still running, which is precisely the case a seek exists for), and
 * counting those burned the whole budget in eight animation frames without
 * sending anything.
 */
export function canSeek(
  state: ScrollState,
  opts: { rowLoaded: boolean; hasMoreOlder: boolean },
): boolean {
  if (opts.rowLoaded) return false;
  if (state.intent.at !== 'row' && state.intent.at !== 'hit') return false;
  return opts.hasMoreOlder && state.pages < SEEK_PAGE_BUDGET;
}

/** Live geometry of the scroll container. Plain numbers, so this is testable. */
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The live box of the row an intent names, relative to the viewport top. */
export interface RowBox {
  /** The row's top, viewport-relative. */
  top: number;
  /** Its CURRENT height — see the stale-offset clamp in `scrollTopForAnchor`. */
  height: number;
}

/**
 * THE TARGET. What `scrollTop` must be for this intent to be satisfied, or null
 * for "we cannot say, so do not touch it".
 *
 * This one function replaces five separate target computations that used to live
 * in five places and disagree: the follow-bottom effect, the settling restore's
 * anchor branch, the older-prepend compensation, the fold-change compensation,
 * and the search-jump placement. Four of them computed the same thing in
 * different coordinate systems, which is how two owners come to disagree about
 * one number.
 *
 * Every answer is ABSOLUTE and derived from live geometry, never a delta applied
 * to a captured one. That is what makes it idempotent, and idempotence is what
 * makes it safe to call from every subscription without double-paying:
 *
 *  · on an engine with scroll anchoring that has already put the row back, the
 *    target equals the current `scrollTop` and the caller declines to write;
 *  · on an engine with none (every iPhone on iOS 26 or earlier — WebKit shipped
 *    anchoring in Safari 27), the same arithmetic pays the whole growth.
 *
 * The double-pay defence is therefore the arithmetic itself, not a feature test.
 * `CSS.supports('overflow-anchor', 'auto')` answers TRUE on an iOS 26 WKWebView
 * that will not pay, and true on Playwright's WebKit that will, so it cannot
 * distinguish the two cases it would be asked to distinguish.
 *
 * A height DELTA (`scrollTop += ΔscrollHeight`) is the form that cannot be made
 * safe: it adds the growth a second time on an engine that already paid — thrown
 * forward by the same 450 px in the measurement — and it yanks a parked reader
 * for growth BELOW them, which should move them not at all.
 */
export function targetFor(
  intent: ScrollIntent,
  geo: ScrollGeometry,
  row: RowBox | null,
): number | null {
  switch (intent.at) {
    case 'nothing':
      return null;
    case 'end':
      return maxScrollTop(geo.scrollHeight, geo.clientHeight);
    case 'row':
      if (!row) return null;
      return scrollTopForAnchor({
        scrollTop: geo.scrollTop,
        rowTop: row.top,
        anchorOffset: intent.offset,
        scrollHeight: geo.scrollHeight,
        clientHeight: geo.clientHeight,
        rowHeight: row.height,
      });
    case 'hit':
      if (!row) return null;
      return scrollTopForSearchHit({
        scrollTop: geo.scrollTop,
        hitTop: row.top,
        scrollHeight: geo.scrollHeight,
        clientHeight: geo.clientHeight,
      });
  }
}

/**
 * How far from the target counts as already there.
 *
 * Sub-pixel layout means an exact comparison never holds, and a target the
 * browser would clamp (iOS rubber-band reports a `scrollTop` outside the range)
 * never equals the value it clamps to — so an exact test would have the
 * mechanism re-assigning, and forcing a reflow, on every notification for as
 * long as the condition lasted.
 */
const TARGET_EPSILON = 1;

/** Is this target already satisfied? Then do not write — see `targetFor`. */
export function alreadyThere(target: number, scrollTop: number): boolean {
  return Math.abs(target - scrollTop) <= TARGET_EPSILON;
}

/**
 * WAS THAT SCROLL EVENT THE READER?
 *
 * The question the old design asked in six places with six different
 * instruments. There is one honest form of it — "is the reader still where we
 * put them?" — and exactly two coordinate systems to ask it in, because there
 * are exactly two kinds of mover that are not the reader:
 *
 *  · WE moved them. Then `scrollTop` is the number we wrote, whatever the
 *    document has done since. This is the case a geometric test cannot see: a
 *    burst of lazy thumbnails finishing in one layout pass means our write of
 *    "the bottom" arrives as an event 2160 px from a bottom that has since moved
 *    (measured: target 24910 against `scrollHeight` 25774, two more screenshots
 *    decoded in the same pass, 27934). Reading that as a gesture un-pinned a
 *    reader who had not moved a pixel, permanently — 3/3 on two trees, with the
 *    distance growing on every later turn.
 *
 *  · THE ENGINE moved them, paying for content that grew above them. Then
 *    `scrollTop` is a number nobody stamped — the engine writes it during layout
 *    — but the row under the reader's eyes has not moved, which is the entire
 *    purpose of the adjustment. This is the case a pixel test cannot see, and it
 *    is measured at about one burst in six.
 *
 * Either ⇒ not the reader. Neither ⇒ the reader.
 *
 * ── WHY THIS IS NOT THE UNION GUARD IT LOOKS LIKE ────────────────────────────
 * The shape is the same as the two-condition guard this replaces, and the
 * difference is the second condition. That guard's was `!userScrolled` — a flag
 * set on the first wheel event of a visit and cleared only on hide, and set
 * EXPLICITLY by the jump-to-latest button. So one nudge, or one tap of the
 * button that means "follow the tail again", disarmed it for the rest of the
 * visit: measured 0/3 and 1/3 respectively, i.e. the bug it was written for,
 * back verbatim, on the tree that had fixed it.
 *
 * Row identity carries no state. It cannot go stale, cannot be disarmed by
 * something that happened a minute ago, and needs no gesture listener to be
 * exhaustive — which matters because the gesture listeners never were. Wheel and
 * touch were the original two; keyboard paging, scrollbar-thumb drags and
 * drag-select autoscroll reached none of them (measured: 7128 px of real
 * drag-select motion, 0 reader verdicts across 158 scroll events), and neither
 * do the two movers nobody had counted at all — sequential focus navigation onto
 * an off-screen button inside the log, and find-in-page. All of those move the
 * reader's row, so all of them land here as the reader, which is the right
 * answer and needs no listener per device.
 */
export function scrollEventIsTheReader(opts: {
  /** The `scrollTop` we last wrote, or null if we have written nothing. */
  wrote: number | null;
  scrollTop: number;
  /** The row under the viewport top NOW. */
  here: Anchor | null;
  /** The row under the viewport top as of the last event or write. */
  was: Anchor | null;
  /** `ScrollState.placed` — have we had a chance to place anyone yet? */
  placed: boolean;
}): boolean {
  // Nothing has been placed since this pane became visible, so there is no "where
  // we put them" for the reader to have moved away FROM. An iOS resume resets
  // overflow scroll and fires an ordinary scroll event reporting 0, which is
  // indistinguishable by geometry from a reader flicking to the top — and
  // believing it wrote the oldest on-screen row over the reader's parked message,
  // which the restore then faithfully reproduced.
  if (!opts.placed) return false;
  // Our own write arriving.
  if (opts.wrote !== null && Math.abs(opts.scrollTop - opts.wrote) <= TARGET_EPSILON) return false;
  // Nothing anchorable to compare — only reachable transiently mid-relayout.
  // Don't guess; the next event will have geometry.
  if (!opts.here) return false;
  // The document moved under a stationary reader.
  if (
    opts.was &&
    opts.here.id === opts.was.id &&
    Math.abs(opts.here.offset - opts.was.offset) <= TARGET_EPSILON
  ) {
    return false;
  }
  return true;
}

/**
 * What to write to the store for this state, or null for "write nothing".
 *
 * ── ONLY A POSITION THE READER CHOSE IS EVER STORED ──────────────────────────
 * This predicate is where a whole class of bug goes to die. The old design wrote
 * the memory from `onScroll`, which fires for every writer's scrollTop as well as
 * the reader's — so the settling restore's own intermediate positions, the
 * seek's mid-flight frames, the prepend compensation and the search jump all
 * recorded themselves as reading positions. It needed a hold flag
 * (`holdRememberedAnchor`) to protect the goal from the loop that was chasing it,
 * and the flag protected `anchorId` but not `ratio` — which is exactly how the
 * landing point came to walk further down the chat on every reopen.
 *
 * Here the store is written from the STATE, not from a scroll event, and the
 * state only carries a reading position when a reader input put one there. A
 * `hit` records nothing (it is a destination the user asked for from somewhere
 * else, not where they were reading), and `nothing` records nothing (we do not
 * know, and the honest form of not knowing is silence, not a guess).
 */
export function recordFor(
  state: ScrollState,
  opts: { caughtUp: boolean; sid: string | null },
): ChatScrollMem | null {
  const { intent } = state;
  if (intent.at === 'hit' || intent.at === 'nothing') return null;
  if (intent.at === 'end') {
    return { anchorId: null, anchorOffset: 0, caughtUp: true, sid: opts.sid };
  }
  // A parked reader whose position happens to satisfy "caught up" — the newest
  // message is short and they are near the end of it — is recorded as caught up,
  // because that is the question re-entry asks and the anchor would only pin
  // them to a message that will not be the newest one for long.
  return opts.caughtUp
    ? { anchorId: null, anchorOffset: 0, caughtUp: true, sid: opts.sid }
    : { anchorId: intent.id, anchorOffset: intent.offset, caughtUp: false, sid: opts.sid };
}
