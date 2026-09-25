import type { ScrollSurface } from './chat-scroll-controller';
/**
 * A DETERMINISTIC LAYOUT ENGINE, for testing the scroll mechanism.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Every bug this rewrite is answering is an ORDERING bug: a prepend and a live
 * append landing in one commit, a thumbnail burst finishing between a write and
 * the scroll event it produces, a fold collapsing above the reader, an engine
 * adjustment arriving with nothing stamped. None of those can be expressed
 * against jsdom, which has no layout engine — `scrollHeight`, `clientHeight` and
 * `getBoundingClientRect` are all zero or constant there. So the entire class
 * was invisible to the suite, and demonstrably so: mutating `scrollTop < 240` to
 * `< -1`, which disables older-history paging outright, left 1013 tests passing.
 *
 * This is a small model of the only layout facts the mechanism depends on: rows
 * in document order with heights, a viewport, a clamped `scrollTop`, and a
 * document that can grow and shrink at either end. It is not a browser. It is
 * the arithmetic a browser would do, stated explicitly so a test can state what
 * it expects.
 *
 * ── THE ENGINE SWITCH ────────────────────────────────────────────────────────
 * `paysAnchoring` models the browser's own `overflow-anchor` behaviour: when
 * content above the reader changes height, the engine adjusts `scrollTop` to
 * keep their row still, and it stamps nothing when it does.
 *
 * Both settings are real, shipping configurations, and every property that
 * touches compensation is asserted under BOTH:
 *
 *   · `true`  — Chromium, and Safari 27 (Sep 2026).
 *   · `false` — every iPhone on iOS 26 or earlier, Safari and the installed PWA
 *     alike, which have no scroll anchoring at all. Also Chromium in any layout
 *     pass where something suppressed it (a computed padding change on an
 *     ancestor of the anchor node will do it), and Chromium for reasons that are
 *     not fully characterised: one hunt measured it paying the full 450px of
 *     growth above a parked reader, and another measured it paying 0 of 6720px
 *     in the same role.
 *
 * That disagreement between two careful measurements is exactly why the
 * mechanism may not ASSUME the engine pays. `false` is not a legacy case to be
 * tolerated; it is the case the arithmetic has to be correct in, with `true` as
 * the case it must not double-pay in.
 */
import type { Anchor, RowBox, ScrollGeometry } from './chat-scroll-intent';

export interface SimRow {
  id: string;
  height: number;
}

export interface SimOptions {
  clientHeight?: number;
  /**
   * Does the engine compensate for height changes above the reader? See the
   * header — both values are shipping configurations.
   */
  paysAnchoring?: boolean;
  /**
   * What FRACTION of a height change above the reader the engine pays. 1 = the
   * whole thing, 0 = nothing. Fractions in between are not hypothetical: one
   * hunt measured Chromium paying 1440 of 1920px in a single frame, and another
   * measured 0 of 6720px in the same role, so "pays exactly" is not a law even on
   * an engine that has anchoring. Ignored when `paysAnchoring` is false.
   */
  anchoringFraction?: number;
  /**
   * Unanchored content below the last row: the streaming preview, the
   * optimistic user bubble, the question card, the queued strip, and the
   * composer's reserve. It is in `scrollHeight` and carries no id, which is
   * exactly the combination that made a row-walking "caught up" rule wrong.
   */
  furnitureBelow?: number;
}

/**
 * The minimum box height the mechanism will measure. A `display:none` pane
 * reports 0, and anything computed from it is a lie.
 */
const MIN_MEASURABLE = 40;

export class SimScroller implements ScrollSurface {
  rows: SimRow[] = [];
  clientHeight: number;
  scrollTop = 0;
  furnitureBelow: number;
  paysAnchoring: boolean;
  anchoringFraction: number;
  /** display:none — clientHeight collapses and every measurement is worthless. */
  hidden = false;
  /**
   * The row carrying the current search hit, or null if none is rendered.
   *
   * Separate from the row list on purpose: a hit is found by the DOM's
   * `[data-search-hit]` marker, not by an id the mechanism holds — because when
   * the seek starts, the message is not loaded and has no id anybody knows.
   */
  hitId: string | null = null;
  /** Every `scrollTop` this surface was ASSIGNED, in order. */
  writes: number[] = [];
  /** Scroll events the model has produced but the caller has not consumed. */
  private pending = 0;

  constructor(rows: SimRow[] = [], opts: SimOptions = {}) {
    this.rows = [...rows];
    this.clientHeight = opts.clientHeight ?? 800;
    this.paysAnchoring = opts.paysAnchoring ?? true;
    this.anchoringFraction = opts.anchoringFraction ?? 1;
    this.furnitureBelow = opts.furnitureBelow ?? 0;
  }

  // ── ScrollSurface ─────────────────────────────────────────────────────────

  geometry(): ScrollGeometry {
    return {
      scrollTop: this.scrollTop,
      scrollHeight: this.scrollHeight,
      clientHeight: this.effectiveClientHeight,
    };
  }

  measurable(): boolean {
    return this.effectiveClientHeight >= MIN_MEASURABLE;
  }

  rowBox(id: string): RowBox | null {
    if (this.hidden) return null;
    let top = 0;
    for (const r of this.rows) {
      if (r.id === id) return { top: top - this.scrollTop, height: r.height };
      top += r.height;
    }
    return null;
  }

  anchorHere(): Anchor | null {
    if (this.hidden || this.rows.length === 0) return null;
    const viewportTop = this.scrollTop;
    let top = 0;
    for (const r of this.rows) {
      // The first row whose BOTTOM is below the viewport top — the one the
      // reader's eye is anchored to.
      if (top + r.height > viewportTop) return { id: r.id, offset: top - viewportTop };
      top += r.height;
    }
    // Every row is above the line: only reachable transiently mid-relayout. The
    // last row is the best available description of where the reader is.
    const last = this.rows[this.rows.length - 1] as SimRow;
    return { id: last.id, offset: this.contentHeight - last.height - viewportTop };
  }

  hitBox(): RowBox | null {
    return this.hitId === null ? null : this.rowBox(this.hitId);
  }

  setScrollTop(value: number): void {
    this.writes.push(value);
    this.assign(value);
  }

  // ── The document changing ─────────────────────────────────────────────────

  /** Older history arriving at the top. The commonest growth ABOVE a reader. */
  prepend(rows: SimRow[]): this {
    const grew = rows.reduce((n, r) => n + r.height, 0);
    this.rows = [...rows, ...this.rows];
    return this.grewAbove(grew);
  }

  /** New output arriving at the end. Growth BELOW a parked reader. */
  append(rows: SimRow[]): this {
    this.rows = [...this.rows, ...rows];
    return this;
  }

  /**
   * A row changing height in place: an image decoding, a fold opening or
   * closing, a font settling, markdown committing.
   */
  resizeRow(id: string, height: number): this {
    let above = 0;
    for (const r of this.rows) {
      if (r.id !== id) {
        above += r.height;
        continue;
      }
      // How much CONTENT sits above the viewport top, before and after. The
      // engine pays the difference — and only that, which is what makes growth
      // below the reader a no-op and growth above them a full payment.
      //
      // A row that straddles the line is modelled as growing at its bottom, so
      // the growth lands below the reader's eyes. That is a model, not a law:
      // a real engine anchors to a node deeper than the row and can do better.
      // It is stated here so a test that depends on it is depending on something
      // written down. (See the row-granularity limit in the spec.)
      const room = Math.max(0, this.scrollTop - above);
      const before = Math.min(r.height, room);
      r.height = height;
      const after = Math.min(height, room);
      return this.grewAbove(after - before);
    }
    throw new Error(`no such row: ${id}`);
  }

  /** The live furniture below the last message growing or shrinking. */
  setFurniture(px: number): this {
    this.furnitureBelow = px;
    return this;
  }

  /** A face/tab switch, or a browser-tab hide. */
  hide(): this {
    this.hidden = true;
    // A hidden overflow container reports scrollTop 0 in every engine this app
    // runs on, which is exactly why a hidden pane must never be measured.
    this.scrollTop = 0;
    return this;
  }

  show(): this {
    this.hidden = false;
    return this;
  }

  /**
   * An iOS resume: the WKWebView comes back with overflow scroll reset to 0 and
   * fires an ordinary scroll event for it, which is indistinguishable by
   * geometry from the reader flicking to the top.
   */
  iosResumeZeroesScroll(): this {
    this.hidden = false;
    this.scrollTop = 0;
    this.pending++;
    return this;
  }

  /** The reader, by any device. Produces a scroll event, like a real one. */
  readerScrollsTo(value: number): this {
    this.assign(value);
    this.pending++;
    return this;
  }

  readerScrollsBy(delta: number): this {
    return this.readerScrollsTo(this.scrollTop + delta);
  }

  readerScrollsToEnd(): this {
    return this.readerScrollsTo(this.maxScrollTop);
  }

  /** Consume one pending scroll event, if any. */
  takeScrollEvent(): boolean {
    if (this.pending === 0) return false;
    this.pending--;
    return true;
  }

  get pendingScrollEvents(): number {
    return this.pending;
  }

  // ── Derived geometry ──────────────────────────────────────────────────────

  get contentHeight(): number {
    return this.rows.reduce((n, r) => n + r.height, 0);
  }

  get scrollHeight(): number {
    return this.hidden ? 0 : this.contentHeight + this.furnitureBelow;
  }

  get effectiveClientHeight(): number {
    return this.hidden ? 0 : this.clientHeight;
  }

  get maxScrollTop(): number {
    return Math.max(0, this.scrollHeight - this.effectiveClientHeight);
  }

  /** How far the named row's top sits from the viewport top. The measurement. */
  rowOffset(id: string): number {
    const box = this.rowBox(id);
    if (!box) throw new Error(`no such row: ${id}`);
    return box.top;
  }

  /**
   * Content grew (or shrank) above the reader by `px`. Model the engine, and
   * fire the scroll event a real adjustment fires.
   */
  private grewAbove(px: number): this {
    const paid = Math.round(px * this.anchoringFraction);
    if (paid !== 0 && this.paysAnchoring && !this.hidden) {
      // The engine's own write. Note it goes through `assign`, NOT through
      // `setScrollTop` — nothing stamps it, which is precisely the property that
      // makes a pixel-identity test blind to it.
      this.assign(this.scrollTop + paid);
      this.pending++;
    }
    return this;
  }

  /** Browsers clamp an assignment to the scrollable range. So does this. */
  private assign(value: number): void {
    this.scrollTop = Math.min(Math.max(0, Math.round(value)), this.maxScrollTop);
  }
}

/** A conversation of `n` rows of `height` each, ids `m0`…`m{n-1}`. */
export function simRows(n: number, height = 200, prefix = 'm'): SimRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, height }));
}
