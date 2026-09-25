import type { ScrollSurface } from './chat-scroll-controller';
/**
 * The DOM behind `ScrollSurface` — the only file that measures a chat log.
 *
 * Split out from `ChatPane.tsx` so the measuring and the deciding are in
 * different files: everything above this line is arithmetic over plain numbers
 * and is tested against a deterministic layout (`chat-scroll-sim.ts`), and
 * everything in here is `getBoundingClientRect`. When the two lived together,
 * five call sites each re-derived "is this box real?", "which row is the reader
 * on?" and "what is the viewport top?" from the element, and they did not all
 * agree.
 */
import type { Anchor, RowBox, ScrollGeometry } from './chat-scroll-intent';

/**
 * The attribute carrying a row's event id.
 *
 * Only TOP-LEVEL children of `.chat-list` have it: the lookups here assume
 * `[data-eid]` boxes are siblings in document order, so their tops are
 * monotonic, which is what makes the binary search below legal.
 */
export const ANCHOR_ATTR = 'data-eid';

/**
 * The smallest box worth measuring.
 *
 * A pane hidden with `display:none` reports `clientHeight` 0 (and usually
 * `scrollTop` 0), and every answer derived from that is a lie — a target
 * computed against it is "the top of the log", and a record written from it
 * names the oldest loaded row. Mid-relayout a visible pane can report the same
 * thing for a frame. 40px is below any real chat viewport and above every
 * degenerate one.
 */
const MIN_MEASURABLE = 40;

/**
 * Index of the first row still (at least partly) on screen: the first whose
 * BOTTOM is below the viewport top. That row is the one the reader's eye is
 * anchored to, and the only one whose identity survives the document changing
 * around it.
 *
 * Binary search, because this runs off scroll events and each probe costs a
 * `getBoundingClientRect` — a linear scan over a few hundred rows would be a
 * per-frame layout tax on a chat that is doing nothing wrong.
 *
 * Returns `count` when every row is above the line (the reader is past the end —
 * only reachable transiently mid-relayout).
 */
export function firstVisibleRow(
  count: number,
  bottomOf: (i: number) => number,
  viewportTop: number,
): number {
  let lo = 0;
  let hi = count; // invariant: the answer is in [lo, hi]
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > viewportTop) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The anchorable rows, in document order. */
function anchorRows(el: HTMLElement): HTMLElement[] {
  const list = el.querySelector('.chat-list');
  const out: HTMLElement[] = [];
  for (const child of list?.children ?? []) {
    if (child instanceof HTMLElement && child.hasAttribute(ANCHOR_ATTR)) out.push(child);
  }
  return out;
}

/**
 * A `ScrollSurface` over a real scroll container.
 *
 * `getEl` rather than an element, because the container is a ref that is null
 * before mount and swapped when the pane's tree changes (the harness picker
 * renders a different tree with no `.chat-scroll` in it).
 *
 * `findHit` is how a search jump's target is resolved: the MARK inside the
 * matched row when there is one, because a hit two thousand pixels down a long
 * answer is not "brought into view" by putting the top of that answer on screen.
 */
export function domScrollSurface(
  getEl: () => HTMLElement | null,
  findHit?: (el: HTMLElement, id: string) => Element | null,
): ScrollSurface {
  const viewportTop = (el: HTMLElement) => el.getBoundingClientRect().top;
  return {
    geometry(): ScrollGeometry {
      const el = getEl();
      if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
      return {
        // CLAMPED on the way in. iOS rubber-band reports a `scrollTop` outside
        // [0, max] for the whole bounce, and a reader paging older history is at
        // the top mid-bounce by construction — so an unclamped reading became a
        // position 40px into the newly prepended page instead of on the same
        // messages. Clamping where the number is READ fixes it for every
        // consumer at once; the previous design clamped it at three of the five
        // places that used it.
        scrollTop: Math.min(
          Math.max(0, el.scrollTop),
          Math.max(0, el.scrollHeight - el.clientHeight),
        ),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    },

    measurable(): boolean {
      const el = getEl();
      return !!el && el.clientHeight >= MIN_MEASURABLE;
    },

    rowBox(id: string): RowBox | null {
      const el = getEl();
      if (!el) return null;
      // A linear scan of the already-collected top-level rows, NOT
      // `querySelector('[data-eid="…"]')`. The selector form walks the entire
      // subtree — and walks ALL of it on the miss, which is the case a seek hits
      // on every frame while it pages the anchor back in. It also needed the id
      // escaped as a CSS string, which this does not.
      const target = findHit ? findHit(el, id) : null;
      if (target) {
        const top = viewportTop(el);
        const r = target.getBoundingClientRect();
        return { top: r.top - top, height: r.height };
      }
      for (const row of anchorRows(el)) {
        if (row.getAttribute(ANCHOR_ATTR) !== id) continue;
        const r = row.getBoundingClientRect();
        return { top: r.top - viewportTop(el), height: r.height };
      }
      return null;
    },

    anchorHere(): Anchor | null {
      const el = getEl();
      if (!el) return null;
      const rows = anchorRows(el);
      if (rows.length === 0) return null;
      const top = viewportTop(el);
      const i = firstVisibleRow(
        rows.length,
        (k) => (rows[k] as HTMLElement).getBoundingClientRect().bottom,
        // +1 so a row whose bottom sits exactly on the line counts as past it,
        // which is what "still on screen" has to mean at the clip edge.
        top + 1,
      );
      // `firstVisibleRow` returns `count` when every row is above the line, which
      // only happens transiently mid-relayout — the last row is still the best
      // available description of where the reader is.
      const row = rows[Math.min(i, rows.length - 1)];
      const id = row?.getAttribute(ANCHOR_ATTR);
      if (!row || !id) return null;
      return { id, offset: Math.round(row.getBoundingClientRect().top - top) };
    },

    setScrollTop(value: number): void {
      const el = getEl();
      if (el) el.scrollTop = value;
    },
  };
}
