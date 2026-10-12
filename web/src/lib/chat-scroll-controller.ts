/**
 * THE ONE WRITER.
 *
 * `chat-scroll-intent.ts` decides where the reader belongs. This decides what
 * `scrollTop` has to be for that to be true, writes it, and remembers that it
 * did — and it is the only code in the chat that assigns a scroll position.
 * Before the rewrite there were eleven such places in `ChatPane.tsx` plus a
 * twelfth writer (the browser's own scroll anchoring) that stamps nothing, and
 * every recent bug was two of them disagreeing about one number.
 *
 * ── WHY THERE IS NO SETTLING LOOP ────────────────────────────────────────────
 * The mechanism this replaces held a position by POLLING: an animation-frame
 * loop that re-asserted the target every frame for 2500 ms, extended by 1500 ms
 * per history page, capped at 15 s, stopped early by a flag. All of that existed
 * to answer "has the document finished changing?" — and every event it was
 * waiting for (an image decoding, the composer regrowing, a history page
 * landing, a font settling) already fires a ResizeObserver notification on an
 * element the component was already observing.
 *
 * So there is no loop and no fuse. `place()` is called from subscriptions, and
 * holding a position is simply the consequence of the intent not changing.
 * Deleted with the loop: RESTORE_SETTLE_MS, RESTORE_HARD_STOP_MS,
 * ANCHOR_SEEK_PAGE_MS, the not-scrollable-yet deadline extension, the `held`
 * freeze, and `userScrolled` — whose only job was to stop the loop.
 *
 * If you find yourself reaching for a timer in here, you have lost a
 * subscription. Go and find it.
 */
import type { ChatScrollMem } from './chat-scroll';
import { readerIsCaughtUp } from './chat-scroll';
import type {
  Anchor,
  RowBox,
  ScrollGeometry,
  ScrollInput,
  ScrollState,
} from './chat-scroll-intent';
import {
  IDLE_STATE,
  SEEK_PAGE_BUDGET,
  alreadyThere,
  canSeek,
  next,
  phase,
  recordFor,
  restoreUnreachable,
  scrollEventIsTheReader,
  targetFor,
} from './chat-scroll-intent';

/**
 * Everything the writer needs from the document, and nothing else.
 *
 * A port rather than an `HTMLElement` so the whole mechanism can be driven by a
 * deterministic fake layout in tests (see `chat-scroll-sim.ts`). jsdom has no
 * layout engine, which is why the previous design's ordering bugs were
 * unreachable from the suite — a mutation that disabled older-history paging
 * entirely left 1013 tests passing.
 */
export interface ScrollSurface {
  /** Live geometry. Read fresh every time; never cached across a frame. */
  geometry(): ScrollGeometry;
  /**
   * Is there a real box to measure? A pane hidden with `display:none` reports
   * clientHeight 0, and every measurement taken from it is a lie — computing a
   * target against it yields 0, which parks the reader at the top of the log.
   */
  measurable(): boolean;
  /** The live box of a row by event id, or null if it is not rendered. */
  rowBox(id: string): RowBox | null;
  /** The row under the viewport top right now, or null if nothing is anchorable. */
  anchorHere(): Anchor | null;
  /**
   * The current search hit's MARK, or null if none is rendered.
   *
   * Found by the DOM's `[data-search-hit]` marker rather than by an id, because
   * a jump starts before the message it names is loaded — and because the mark
   * can be nested deep inside a message, or inside an action run the highlight
   * forced open, where a top-level row scan cannot reach it.
   */
  hitBox(): RowBox | null;

  /** Assign `scrollTop`. The ONLY place this happens. */
  setScrollTop(value: number): void;

  /**
   * Is the reader's own motion still in flight — a finger on the glass, or the
   * glide that follows it?
   *
   * ── WHY ANYTHING NEEDS TO ASK ─────────────────────────────────────────────
   * A momentum glide fires NO wheel, NO touchmove and NO key for up to a
   * second or two after the finger lifts — only `scroll`. So the reader's
   * input is silent for the part of the gesture that covers the most distance,
   * and scrolling UP is exactly when older history arrives. A prepend landing
   * in that window is indistinguishable from the reader's own movement, and
   * measured in the simulator it ERASES the glide at every engine payment
   * fraction — nothing, half and in full alike.
   *
   * The answer is not a better discriminator. It is to stop creating the
   * collision: history is not inserted while this is true, so the document
   * stands still for the whole gesture and plain arithmetic settles who moved.
   */
  inMotion(): boolean;

  /**
   * How far the READER has asked to move since this was last called, in
   * pixels, and zero if they have not touched anything.
   *
   * ── WHY THIS CANNOT BE INFERRED FROM `scrollTop` ──────────────────────────
   * It was, and the inference is impossible rather than merely hard. When a
   * prepend of `P` lands, the engine compensates by some `E` in `[0, P]` —
   * nothing (iOS 26 and earlier), all of it (Chromium, Safari 27), or any
   * fraction in between, which is a real observed Chromium behaviour and has
   * its own test. The reader meanwhile moves by `D`. All `place()` can see is
   * `E + D`, and two unknowns do not come out of one number.
   *
   * The old guard resolved it by believing the reader only when the document
   * had not moved at all — which is never true on the frames where history
   * arrives, so a gesture landing in the same frame as a prepend was filed as
   * layout and handed straight back. Measured in Chromium on a real chat:
   * about one frame in twelve of a scroll-up moved the view not at all, each
   * carrying a `place()` write of exactly the step just made. Reported as
   * "scrolling up from the bottom is super buggy and janky and stuck".
   *
   * So the reader's half is OBSERVED instead: wheel deltas, touch drags, and
   * the keys that scroll. `E` never has to be known.
   *
   * Reading it CONSUMES it, so one gesture is attributed once.
   */
  takeReaderIntent(): number;
}

/**
 * The live scroll mechanism for one chat pane.
 *
 * Holds the state machine and the discriminator's last write and observations.
 * A commit can observe movement before the native event arrives; that verdict
 * is retained for delivery to the caller that persists reading positions.
 */
export class ChatScrollController {
  private state: ScrollState = IDLE_STATE;
  /** The `scrollTop` we last assigned. null = we have written nothing. */
  private wrote: number | null = null;
  /** The row under the viewport top as of the last event or write. */
  private was: Anchor | null = null;
  /**
   * The reader's own travel since the last settle, in pixels.
   *
   * ── ONE OBSERVATION, READ BY BOTH ENTRY POINTS ────────────────────────────
   * `place()` and `onScroll()` both have to answer "did the reader move?", and
   * they used to answer it from different evidence: `place()` from input and
   * the document's stillness, `onScroll()` from whether the anchor row's
   * offset had changed. Partial anchoring changes that offset with nobody
   * touching anything, so the same frame reached 2000 delivered commit-first
   * and 2450 delivered scroll-first.
   *
   * `takeReaderIntent()` CONSUMES, so whichever arrived first used to eat the
   * evidence the other needed. It accumulates here instead and is cleared only
   * by `settled()`, so the order of delivery cannot change the answer.
   */
  private intentSinceSettle = 0;
  /**
   * The `scrollTop` we last OBSERVED, whoever moved it. null = never looked.
   *
   * Only one question needs it, and only about a reader event: which WAY did
   * they go. See `followingAfter`. Updated on every scroll event and after every
   * place, so it is never a pre-engine-adjustment number that a later gesture
   * would be compared against.
   */
  private sawTop: number | null = null;
  /** Previous anchor's document position, to distinguish motion from relayout. */
  private wasDocumentTop: number | null = null;
  /** A commit observed the gesture before its queued native scroll event. */
  private pendingReader = false;
  /** Hidden remains a gate even if the DOM is already measurable on resume. */
  private hidden = false;

  constructor(private readonly surface: ScrollSurface) {}

  /** For tests and for the pager: the brief's four states, derived. */
  phase(hasMoreOlder: boolean): ReturnType<typeof phase> {
    return phase(this.state, { rowLoaded: this.rowLoaded(), hasMoreOlder });
  }

  intent(): ScrollState['intent'] {
    return this.state.intent;
  }

  /**
   * Has the seek spent its whole budget?
   *
   * The ONLY honest basis for telling a reader "it is further back than the
   * history loaded here". A pane that never entered the hit state, or whose
   * seek never ran, returns false — because "I looked and could not find it"
   * and "I never looked" are different facts, and the banner cannot distinguish
   * them on the reader's behalf.
   */
  spentSeekBudget(): boolean {
    return this.state.pages >= SEEK_PAGE_BUDGET;
  }

  /** Has anything read this pane's layout since it became visible? */
  hasPlaced(): boolean {
    return this.state.placed;
  }

  /** The live box of a row, for callers that need to measure before an input. */
  rowBox(id: string): RowBox | null {
    return this.surface.rowBox(id);
  }

  /** The row under the viewport top right now. */
  anchorHere(): Anchor | null {
    return this.surface.anchorHere();
  }

  /**
   * Is the reader's own motion still in flight?
   *
   * The caller holds older history back while this is true — see `inMotion` on
   * the surface for why a prepend landing inside a glide cannot be told from
   * the glide itself.
   */
  readerIsMoving(): boolean {
    return this.surface.inMotion();
  }

  /** May we ask for another page of history to reach the current intent? */
  wantsOlder(hasMoreOlder: boolean): boolean {
    return canSeek(this.state, { rowLoaded: this.rowLoaded(), hasMoreOlder });
  }

  /**
   * A restore that can never land — see `restoreUnreachable`.
   *
   * The caller converts it to "open at the newest message". It is asked on
   * every commit rather than once at mount, because the row may arrive: a tail
   * that happens to contain the remembered anchor satisfies the restore
   * normally, and only when the events have settled without it does the reader
   * belong at the end.
   */
  strandedRestore(hasMoreOlder: boolean): boolean {
    // ── NOT BEFORE THERE IS A TRANSCRIPT TO BE ABSENT FROM ─────────────────
    // The docstring above promised "only when the events have settled without
    // it", and nothing enforced it. The caller runs on EVERY commit including
    // the first, when the list is empty — so a restore was declared
    // unreachable before a single row existed, converted to "open at the
    // newest message", and the reader was pinned to the bottom a moment
    // before the row they wanted rendered.
    //
    // Measured on a reload of a real chat: the remembered row came back as
    // row 15 of 29, `caughtUp: false` in the record, and the reader was at the
    // very bottom. The restore had not failed to find it — it had given up
    // before looking.
    //
    // An empty list is not evidence of absence. One rendered row is enough to
    // make the question meaningful, because the opening tail arrives in one
    // commit.
    if (this.surface.anchorHere() === null) return false;
    return restoreUnreachable(this.state, { rowLoaded: this.rowLoaded(), hasMoreOlder });
  }

  private rowLoaded(): boolean {
    return this.boxFor() !== null;
  }

  /** The box the current intent needs, or null if it names nothing loaded. */
  private boxFor(): RowBox | null {
    const { intent } = this.state;
    if (intent.at === 'row') return this.surface.rowBox(intent.id);
    if (intent.at === 'hit') return this.surface.hitBox();
    return null;
  }

  /**
   * Feed the machine an input, then satisfy whatever it now wants.
   *
   * Placing immediately is what makes an input FEEL like a command rather than a
   * request: a fold toggle holds the header in the same commit that changed its
   * height, and a re-entry places before paint, so the reader never sees the
   * pre-restore position.
   */
  dispatch(input: ScrollInput): void {
    // Typing clears the highlight even when none exists. Only a live hit needs
    // conversion to a reading position; a reader gesture already established it.
    const updated = next(this.state, input);
    if (input.t === 'search-cleared' && updated === this.state) return;
    if (input.t === 'hidden') {
      this.hidden = true;
      this.pendingReader = false;
    } else if (input.t === 'shown' || input.t === 'mounted') {
      this.hidden = false;
    }
    this.state = updated;
    // A reader input is the one thing that can change where they belong, so it
    // is the one thing that can change what we store. Note what does NOT reach
    // here: a height change, a scroll event we attributed to layout, a tick of
    // any clock. See `recordFor`.
    this.place(false);
  }

  /**
   * Satisfy the current intent, if it can be satisfied and is not already true.
   *
   * Called from every subscription that can change the document's geometry —
   * the ResizeObserver on the scroller and the list, and the commit that renders
   * new events. Idempotent by construction: `targetFor` computes an absolute
   * position from live geometry, so calling this twice in a row writes once.
   */
  /** Fold anything the reader has done into the shared observation. Called by
   *  every entry point, before either of them decides anything. */
  private observe(): void {
    this.intentSinceSettle += this.surface.takeReaderIntent();
  }

  place(reconcileReader = true): void {
    // Nothing to read — a hidden or mid-relayout pane. We have NOT looked, so
    // the gate stays shut.
    if (this.hidden || !this.surface.measurable()) return;
    this.observe();
    const before = this.surface.geometry();
    const oldBox = this.was ? this.surface.rowBox(this.was.id) : null;
    /**
     * A streaming commit may beat the native scroll event, so `place()` has to
     * decide whether a `scrollTop` it did not write was the READER or the
     * engine compensating for a prepend — and overwrite only the second.
     *
     * ── HOW MUCH THE DOCUMENT MOVED, WHICH IS KNOWABLE ────────────────────
     * The anchor row's DOCUMENT coordinate shifts by exactly what was inserted
     * above it. That is true on every engine, because it is a fact about the
     * content rather than about scrolling.
     */
    /**
     * The reader's half of this frame, OBSERVED rather than inferred — see
     * `takeReaderIntent` for why the inference is impossible and what it cost.
     * A shrink clamped to the new maximum is layout, not a gesture.
     */
    const clampedShrink =
      this.sawTop !== null &&
      before.scrollTop < this.sawTop &&
      before.scrollTop >= before.scrollHeight - before.clientHeight;
    const fromInput = this.intentSinceSettle;
    /**
     * How far the document moved UNDER the reader, which is knowable on every
     * engine because it is a fact about content rather than about scrolling:
     * the anchor row's DOCUMENT coordinate shifts by exactly what was inserted
     * above it. Content appended BELOW does not move it, and so does not
     * appear here — which is the difference between a prepend, which the
     * reader must be carried through, and an append, which must not move them
     * at all.
     */
    const shift =
      oldBox && this.wasDocumentTop !== null
        ? oldBox.top + before.scrollTop - this.wasDocumentTop
        : 0;
    /**
     * ── AND THE INPUT IS NOT THE ONLY WAY TO SCROLL ──────────────────────
     * Dragging the SCROLLBAR fires no wheel, no touch and no key — and nor
     * does a middle-click autoscroll or a click in the scrollbar track. An
     * input-only rule drops all of them, which the first version of this fix
     * did: a probe that moved `scrollTop` directly, the way a scrollbar drag
     * does, recorded no position at all.
     *
     * The rule it replaced was not wrong, it was INCOMPLETE: when nothing
     * arrived above the reader there is nothing for the engine to compensate,
     * so any movement must be theirs and plain arithmetic settles it. It only
     * failed when a prepend landed in the same frame — which is exactly the
     * case the input signal answers.
     *
     * So: believe the input when there is some, and fall back to the
     * arithmetic when the document stood still. Each covers the other's gap.
     */
    const stillDocument = Math.abs(shift) <= 1;
    const fromGeometry = this.sawTop === null ? 0 : before.scrollTop - this.sawTop;
    const intentPx = Math.abs(fromInput) > 1 ? fromInput : stillDocument ? fromGeometry : 0;
    const readerMoved =
      reconcileReader && this.state.placed && Math.abs(intentPx) > 1 && !clampedShrink;

    // We have looked. Everything below is about what we found; this is true
    // either way, including when the answer is "we do not know where the reader
    // belongs yet". See the `measured` input.
    this.state = next(this.state, { t: 'measured' });
    const geo = this.surface.geometry();
    const { intent } = this.state;
    const target = targetFor(intent, geo, this.boxFor());
    if (target === null) {
      // We do not know where the reader belongs — the transcript has not
      // arrived, or the message is older than the loaded window. Leave the
      // scroll exactly where it is and let the seek page history in. This is
      // where a ratio fallback used to place a guess.
      //
      this.settled();
      return;
    }
    /**
     * ── PAY THE SHIFT FIRST, THEN THE GESTURE ────────────────────────────
     * `target` is where the reader's row belongs with whatever the engine did
     * not pay made up — an absolute position, which is why the same arithmetic
     * serves an engine that pays nothing, one that pays in full, and one that
     * pays a fraction. The gesture then applies ON TOP of that.
     *
     * The order is the point. Reconciling first — asking "where is the reader
     * now?" before the prepend is compensated — reads an anchor that is still
     * displaced by everything the engine has not paid, and files THAT as the
     * reader's chosen position. On an engine that pays nothing, that is the
     * entire prepend: a 2000px jump recorded as intent.
     */
    /**
     * Where the reader belongs when they have just moved: WHERE THEY WERE,
     * carried through whatever arrived above them, plus the gesture. Absolute,
     * so it is the same answer on an engine that pays anchoring in full, one
     * that pays nothing, and one that pays a fraction.
     *
     * NOT `target + intentPx`. `target` answers the OLD intent, and while the
     * reader is following the tail that intent is "the end" — so an append of
     * 200px landing in the same frame as an upward nudge would re-follow to
     * the new end and then back off by the nudge, carrying the reader 200px
     * down the document they were trying to leave. Their position is a fact;
     * only what moved above them is a correction.
     */
    const want = readerMoved && this.sawTop !== null ? this.sawTop + shift + intentPx : target;
    if (!alreadyThere(want, geo.scrollTop)) {
      // Not already true, so pay. Where scroll anchoring has already put the
      // row back, the target equals the current position and we stay out of
      // the way — the double-pay defence, with no feature test.
      this.wrote = want;
      this.surface.setScrollTop(want);
    }
    if (readerMoved) {
      // The reader is the authority: whatever they are looking at NOW is the
      // intent, including "the end", which is how following is regained. Read
      // after the write above, so the row recorded is the one they can see
      // rather than one the engine still owes for.
      this.wrote = null;
      const after = this.surface.geometry();
      this.state = next(this.state, {
        t: 'reader-moved',
        here: this.surface.anchorHere(),
        atEnd: this.followingAfter(after, this.sawTop),
      });
      this.pendingReader = true;
    }
    this.settled();
  }

  /**
   * Every exit from `place()` goes through here, and it is the only thing that
   * updates the discriminator's baseline.
   *
   * One refresh rather than one per branch, because a mutation test could not
   * distinguish two of the three per-branch assignments from dead code — and an
   * assignment I cannot demonstrate the need for, to a value the reader-vs-layout
   * decision depends on, is the exact shape of the bugs this rewrite is undoing.
   * Read AFTER any write, so it describes the document as the reader will next
   * see it: otherwise the scroll event our own assignment is about to produce
   * would compare against a position that no longer exists and read as a gesture.
   */
  private settled(): void {
    // The reader's travel has been accounted for by whoever just acted on it.
    this.intentSinceSettle = 0;
    this.was = this.surface.anchorHere();
    this.sawTop = this.surface.geometry().scrollTop;
    this.wasDocumentTop = this.was ? this.was.offset + this.sawTop : null;
  }

  /**
   * A scroll event arrived. Decide whether it was the reader, and if so, where
   * they now want to be.
   *
   * Returns true when the caller should re-write the stored record — i.e. when
   * the reader chose a new position. Everything else is layout, and layout has
   * no opinion about where the reader belongs.
   */
  onScroll(): boolean {
    if (this.hidden || !this.surface.measurable()) return false;
    this.observe();
    const geo = this.surface.geometry();
    // Captured BEFORE anything can refresh it, and refreshed for every event —
    // the reader's and the engine's alike. An engine adjustment that goes
    // unrecorded here would leave a pre-adjustment number for the reader's next
    // gesture to be compared against, and the direction below would be a
    // statement about the engine's move rather than theirs.
    const prevTop = this.sawTop;
    this.sawTop = geo.scrollTop;
    const here = this.surface.anchorHere();
    // The same two facts `place()` weighs, so neither entry point can reach a
    // conclusion the other would not. See `intentSinceSettle`.
    const oldBox = this.was ? this.surface.rowBox(this.was.id) : null;
    const shift =
      oldBox && this.wasDocumentTop !== null ? oldBox.top + geo.scrollTop - this.wasDocumentTop : 0;
    const isReader = scrollEventIsTheReader({
      wrote: this.wrote,
      scrollTop: geo.scrollTop,
      here,
      was: this.was,
      placed: this.state.placed,
      documentShifted: Math.abs(shift) > 1,
      inputMoved: Math.abs(this.intentSinceSettle) > 1,
    });
    // `was` is refreshed by `place()`, and only by `place()` — including on the
    // reader path below, which goes through `dispatch`. An earlier draft
    // refreshed it here as well; a mutation test showed the non-reader half was
    // redundant, and deleting BOTH halves then broke two tests, because this
    // method used to mutate the state inline and so never reached a `place()` at
    // all. The fix is the rule, not a second assignment: one owner for the
    // scroll position, and one owner for the bookkeeping the discriminator reads.
    const pending = this.pendingReader;
    this.pendingReader = false;
    if (!isReader) return pending;
    // `wrote` is cleared BEFORE dispatching, so the reader's own position cannot
    // be excused as "our own write arriving" on the strength of a number they
    // have since scrolled away from.
    this.wrote = null;
    // The reader is the authority. Whatever they are looking at now IS the
    // intent — including "the end", which is how following is regained. Their
    // position is by definition already satisfied, so the `place()` this
    // triggers computes a target equal to where they are and writes nothing.
    this.dispatch({ t: 'reader-moved', here, atEnd: this.followingAfter(geo, prevTop) });
    return true;
  }

  /** The record to store for the current state, or null for "write nothing". */
  record(sid: string | null): ChatScrollMem | null {
    if (!this.surface.measurable()) return null;
    if (this.hidden) return recordFor(this.state, { caughtUp: false, sid });
    return recordFor(this.state, { caughtUp: readerIsCaughtUp(this.surface.geometry()), sid });
  }

  /**
   * Is the reader still following the tail, after a move they just made?
   *
   * ── WHY DIRECTION, AND NOT JUST THE BAND ──────────────────────────────────
   * The band alone made the bottom 40 px a DEAD ZONE. Measured in Chrome against
   * the live chat, from a reader parked exactly at the end:
   *
   *     upward notch    net movement    writes
   *        10 px            0 px          1
   *        25 px            0 px          1
   *        39 px            0 px          1
   *        45 px           45 px          0
   *        80 px           80 px          0
   *
   * Zero, not "moved then sprang back" — the write lands in the same turn as the
   * reader's own scroll event, so nothing is ever painted at the new position.
   * The reader pushes and the page does not move. That is the reported symptom
   * verbatim: "if I go all the way to the bottom of this chat and try to scroll
   * back it resists".
   *
   * And the docstring this replaces already described the right behaviour —
   * "nudging up a line to re-read something should stop the log scrolling itself
   * under you" — it was just wrong about the number being tight enough to do it.
   * 40 px is three lines, and a trackpad's opening notches are 10–30 px, so the
   * start of every gentle upward gesture landed inside it. Lowering the number
   * only shrinks the dead zone: a trackpad ramps from 1–2 px, so SOME threshold
   * always eats the first events of a slow gesture.
   *
   * So the band stops being the whole answer. A reader who moved AWAY from the
   * end is not following, at any distance — that is what the gesture MEANT, and
   * it needs no threshold to be read correctly. The band keeps the only job it
   * was ever right about: deciding whether a move TOWARD the end (or one that
   * did not change `scrollTop` at all) has arrived close enough to count as
   * catching up, so following is regained by scrolling back down without having
   * to land on the exact pixel.
   *
   * Still deliberately NOT the re-entry threshold (160 px, `readerIsCaughtUp`):
   * a nudge should stop the log scrolling under you now, and should not park you
   * in history tomorrow. Persisting the first as the second is the bug that
   * stranded a reader 5701 px up after a single wheel notch.
   */
  private followingAfter(geo: ScrollGeometry, prevTop: number | null): boolean {
    // Moved away from the tail. Their intent is the one thing that cannot be
    // overruled by arithmetic about where they happen to have ended up.
    if (prevTop !== null && geo.scrollTop < prevTop) return false;
    return geo.scrollHeight - geo.scrollTop - geo.clientHeight < FOLLOW_THRESHOLD_PX;
  }
}

export const FOLLOW_THRESHOLD_PX = 40;
