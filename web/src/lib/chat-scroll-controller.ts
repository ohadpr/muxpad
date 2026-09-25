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
  alreadyThere,
  canSeek,
  next,
  phase,
  recordFor,
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
  /** Assign `scrollTop`. The ONLY place this happens. */
  setScrollTop(value: number): void;
}

/**
 * The live scroll mechanism for one chat pane.
 *
 * Holds the state machine plus the two things the discriminator needs — what we
 * last wrote, and where the reader's row was last time we looked. Those two are
 * bookkeeping about OUR OWN actions, which is the only kind of state this design
 * keeps: there is deliberately no flag describing the reader.
 */
export class ChatScrollController {
  private state: ScrollState = IDLE_STATE;
  /** The `scrollTop` we last assigned. null = we have written nothing. */
  private wrote: number | null = null;
  /** The row under the viewport top as of the last event or write. */
  private was: Anchor | null = null;

  constructor(private readonly surface: ScrollSurface) {}

  /** For tests and for the pager: the brief's four states, derived. */
  phase(hasMoreOlder: boolean): ReturnType<typeof phase> {
    return phase(this.state, { rowLoaded: this.rowLoaded(), hasMoreOlder });
  }

  intent(): ScrollState['intent'] {
    return this.state.intent;
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

  /** May we ask for another page of history to reach the current intent? */
  wantsOlder(hasMoreOlder: boolean): boolean {
    return canSeek(this.state, { rowLoaded: this.rowLoaded(), hasMoreOlder });
  }

  private rowLoaded(): boolean {
    const { intent } = this.state;
    if (intent.at !== 'row' && intent.at !== 'hit') return false;
    return this.surface.rowBox(intent.id) !== null;
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
    this.state = next(this.state, input);
    // A reader input is the one thing that can change where they belong, so it
    // is the one thing that can change what we store. Note what does NOT reach
    // here: a height change, a scroll event we attributed to layout, a tick of
    // any clock. See `recordFor`.
    this.place();
  }

  /**
   * Satisfy the current intent, if it can be satisfied and is not already true.
   *
   * Called from every subscription that can change the document's geometry —
   * the ResizeObserver on the scroller and the list, and the commit that renders
   * new events. Idempotent by construction: `targetFor` computes an absolute
   * position from live geometry, so calling this twice in a row writes once.
   */
  place(): void {
    // Nothing to read — a hidden or mid-relayout pane. We have NOT looked, so
    // the gate stays shut.
    if (!this.surface.measurable()) return;
    // We have looked. Everything below is about what we found; this is true
    // either way, including when the answer is "we do not know where the reader
    // belongs yet". See the `measured` input.
    this.state = next(this.state, { t: 'measured' });
    const geo = this.surface.geometry();
    const { intent } = this.state;
    const row = intent.at === 'row' || intent.at === 'hit' ? this.surface.rowBox(intent.id) : null;
    const target = targetFor(intent, geo, row);
    if (target === null) {
      // We do not know where the reader belongs — the transcript has not
      // arrived, or the message is older than the loaded window. Leave the
      // scroll exactly where it is and let the seek page history in. This is
      // where a ratio fallback used to place a guess.
      //
      this.settled();
      return;
    }
    if (alreadyThere(target, geo.scrollTop)) {
      // Already true. Do NOT write — this is the whole double-pay defence, and
      // it is what makes one owner safe next to an engine that is also an owner:
      // where scroll anchoring has already put the row back, the target we
      // compute equals the current position and we stay out of the way. Where it
      // paid nothing (every iPhone on iOS 26 or earlier), the branch below pays
      // in full. Same arithmetic, no feature test, no double payment.
      this.settled();
      return;
    }
    this.wrote = target;
    this.surface.setScrollTop(target);
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
    this.was = this.surface.anchorHere();
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
    if (!this.surface.measurable()) return false;
    const geo = this.surface.geometry();
    const here = this.surface.anchorHere();
    const isReader = scrollEventIsTheReader({
      wrote: this.wrote,
      scrollTop: geo.scrollTop,
      here,
      was: this.was,
      placed: this.state.placed,
    });
    // `was` is refreshed by `place()`, and only by `place()` — including on the
    // reader path below, which goes through `dispatch`. An earlier draft
    // refreshed it here as well; a mutation test showed the non-reader half was
    // redundant, and deleting BOTH halves then broke two tests, because this
    // method used to mutate the state inline and so never reached a `place()` at
    // all. The fix is the rule, not a second assignment: one owner for the
    // scroll position, and one owner for the bookkeeping the discriminator reads.
    if (!isReader) return false;
    // `wrote` is cleared BEFORE dispatching, so the reader's own position cannot
    // be excused as "our own write arriving" on the strength of a number they
    // have since scrolled away from.
    this.wrote = null;
    // The reader is the authority. Whatever they are looking at now IS the
    // intent — including "the end", which is how following is regained. Their
    // position is by definition already satisfied, so the `place()` this
    // triggers computes a target equal to where they are and writes nothing.
    this.dispatch({ t: 'reader-moved', here, atEnd: this.followingHere(geo) });
    return true;
  }

  /** The record to store for the current state, or null for "write nothing". */
  record(sid: string | null): ChatScrollMem | null {
    if (!this.surface.measurable()) return null;
    return recordFor(this.state, { caughtUp: readerIsCaughtUp(this.surface.geometry()), sid });
  }

  /**
   * How close to the bottom still counts as following the live output.
   *
   * Deliberately tight, and deliberately not the re-entry threshold: nudging up
   * a line to re-read something should stop the log scrolling itself under you
   * (this one), and should NOT park you in history tomorrow (that one, 160px,
   * in `readerIsCaughtUp`). Persisting the first as the second is the bug that
   * stranded a reader 5701px up after a single wheel notch.
   */
  private followingHere(geo: ScrollGeometry): boolean {
    return geo.scrollHeight - geo.scrollTop - geo.clientHeight < FOLLOW_THRESHOLD_PX;
  }
}

export const FOLLOW_THRESHOLD_PX = 40;
