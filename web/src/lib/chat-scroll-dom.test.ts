/**
 * The DOM surface — the one place the chat log is measured.
 *
 * jsdom has no layout engine, so the geometry is defined explicitly here rather
 * than laid out. That is the honest limit of this file: it tests the ARITHMETIC
 * the surface does on top of what the browser reports (clamping, row selection,
 * the zero-height guard), not the browser's numbers. The mechanism driven by
 * those numbers is tested against a full layout model in
 * chat-scroll-controller.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { domScrollSurface, firstVisibleRow } from './chat-scroll-dom';

/** A scroll container whose geometry we state outright. */
function scroller(opts: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  rows?: { id: string; top: number; height: number }[];
}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-scroll';
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true });
  let top = opts.scrollTop;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  el.getBoundingClientRect = () => ({ top: 0, bottom: opts.clientHeight }) as DOMRect;
  const list = document.createElement('div');
  list.className = 'chat-list';
  el.appendChild(list);
  for (const r of opts.rows ?? []) {
    const row = document.createElement('div');
    row.setAttribute('data-eid', r.id);
    // Viewport-relative, which is what getBoundingClientRect gives — the surface
    // subtracts the container's own top, which is 0 here.
    row.getBoundingClientRect = () =>
      ({ top: r.top, bottom: r.top + r.height, height: r.height }) as DOMRect;
    list.appendChild(row);
  }
  return el;
}

describe('firstVisibleRow', () => {
  const bottoms = [100, 200, 300, 400, 500];
  const of = (i: number) => bottoms[i] as number;

  it('picks the row straddling the viewport top', () => {
    expect(firstVisibleRow(5, of, 250)).toBe(2);
  });

  it('picks row 0 when nothing is scrolled past', () => {
    expect(firstVisibleRow(5, of, 0)).toBe(0);
  });

  it('treats a row whose bottom is exactly on the line as already past', () => {
    expect(firstVisibleRow(5, of, 200)).toBe(2);
  });

  it('returns `count` when every row is above the line (transient relayout)', () => {
    expect(firstVisibleRow(5, of, 9999)).toBe(5);
  });

  it('is a binary search — it must not read every row', () => {
    let reads = 0;
    const counted = (i: number) => {
      reads++;
      return (i + 1) * 100;
    };
    firstVisibleRow(1024, counted, 51_200);
    expect(reads).toBeLessThanOrEqual(11);
  });
});

describe('geometry', () => {
  // ── THE RUBBER BAND ───────────────────────────────────────────────────────
  // iOS overscroll reports a `scrollTop` outside [0, max] for the whole bounce,
  // and a reader paging older history IS at the top of the document mid-bounce,
  // by construction. Unclamped, an older batch landed them 40px INTO the newly
  // prepended page instead of on the same messages.
  //
  // The clamp is HERE, where the number is read, rather than at each consumer.
  // The previous design clamped at three of the five places that used it, and
  // the other two disagreed — which is the general shape of every bug in this
  // area. A mutation sweep found this had no test at all: removing the clamp
  // left the whole suite green, because the sim supplies its own geometry and
  // never exercises this file.
  it('clamps an overscrolled scrollTop to the top of the range', () => {
    const el = scroller({ scrollTop: -40, scrollHeight: 10_000, clientHeight: 800 });
    expect(domScrollSurface(() => el).geometry().scrollTop).toBe(0);
  });

  it('clamps a scrollTop past the end of the range', () => {
    const el = scroller({ scrollTop: 9_999, scrollHeight: 10_000, clientHeight: 800 });
    expect(domScrollSurface(() => el).geometry().scrollTop).toBe(9_200);
  });

  it('leaves an ordinary position alone', () => {
    const el = scroller({ scrollTop: 3_000, scrollHeight: 10_000, clientHeight: 800 });
    expect(domScrollSurface(() => el).geometry()).toEqual({
      scrollTop: 3_000,
      scrollHeight: 10_000,
      clientHeight: 800,
    });
  });

  it('a document shorter than its viewport has no range to clamp into', () => {
    const el = scroller({ scrollTop: 0, scrollHeight: 400, clientHeight: 800 });
    expect(domScrollSurface(() => el).geometry().scrollTop).toBe(0);
  });

  it('reports nothing when there is no element yet', () => {
    expect(domScrollSurface(() => null).geometry()).toEqual({
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    });
  });
});

describe('measurable — the zero-height guard', () => {
  // A pane hidden with display:none reports clientHeight 0, and every answer
  // derived from it is a lie: a target computed against it is "the top of the
  // log", and a record written from it names the oldest loaded row.
  it('refuses a collapsed box', () => {
    expect(
      domScrollSurface(() =>
        scroller({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
      ).measurable(),
    ).toBe(false);
  });

  it('refuses an absurdly short one — a pane mid-relayout', () => {
    expect(
      domScrollSurface(() =>
        scroller({ scrollTop: 0, scrollHeight: 900, clientHeight: 12 }),
      ).measurable(),
    ).toBe(false);
  });

  it('accepts a real viewport', () => {
    expect(
      domScrollSurface(() =>
        scroller({ scrollTop: 0, scrollHeight: 900, clientHeight: 800 }),
      ).measurable(),
    ).toBe(true);
  });

  it('refuses when there is no element', () => {
    expect(domScrollSurface(() => null).measurable()).toBe(false);
  });
});

describe('anchorHere — which message the reader is looking at', () => {
  const rows = [
    { id: 'm0', top: -500, height: 200 },
    { id: 'm1', top: -300, height: 200 },
    { id: 'm2', top: -100, height: 200 },
    { id: 'm3', top: 100, height: 200 },
  ];

  it('names the row under the viewport top, and how far into it the reader is', () => {
    const el = scroller({ scrollTop: 500, scrollHeight: 10_000, clientHeight: 800, rows });
    expect(domScrollSurface(() => el).anchorHere()).toEqual({ id: 'm2', offset: -100 });
  });

  it('is null when nothing is anchorable', () => {
    const el = scroller({ scrollTop: 0, scrollHeight: 900, clientHeight: 800 });
    expect(domScrollSurface(() => el).anchorHere()).toBeNull();
  });

  // ── ONLY DIRECT CHILDREN ──────────────────────────────────────────────────
  // The binary search is legal only because row bottoms are monotonic, and they
  // are monotonic only because the rows are in-flow siblings. A `data-eid` that
  // ends up on a NESTED element breaks that invariant, and the search does not
  // fail loudly when it does — it returns a confident wrong answer.
  //
  // The geometry below is chosen so the two scans DISAGREE: with a subtree walk
  // the nested row sorts between the two real ones and is selected; with direct
  // children it is not there at all. An earlier version of this test used four
  // rows and passed either way, which is no test.
  it('ignores a data-eid on a nested element, which would break monotonicity', () => {
    const two = [
      { id: 'm0', top: -300, height: 200 },
      { id: 'm1', top: -100, height: 200 },
    ];
    const el = scroller({ scrollTop: 500, scrollHeight: 10_000, clientHeight: 800, rows: two });
    const nested = document.createElement('div');
    nested.setAttribute('data-eid', 'inner');
    nested.getBoundingClientRect = () => ({ top: -150, bottom: 50, height: 200 }) as DOMRect;
    (el.querySelector('[data-eid="m0"]') as HTMLElement).appendChild(nested);
    expect(domScrollSurface(() => el).anchorHere()?.id).toBe('m1');
  });

  // ── THE CLIP EDGE ─────────────────────────────────────────────────────────
  // A row whose bottom sits within a pixel of the viewport top is not what the
  // reader is looking at — it is the sliver of the previous message still
  // technically on screen. The `+ 1` is what says so, and without it the anchor
  // names the row ABOVE the one under the reader's eyes, which then restores
  // them a whole message too far back.
  it('does not anchor to a one-pixel sliver of the row above', () => {
    const sliver = [
      { id: 'm0', top: -199, height: 200 }, // bottom lands 1px below the line
      { id: 'm1', top: 1, height: 200 },
    ];
    const el = scroller({ scrollTop: 500, scrollHeight: 10_000, clientHeight: 800, rows: sliver });
    expect(domScrollSurface(() => el).anchorHere()).toEqual({ id: 'm1', offset: 1 });
  });
});

describe('rowBox', () => {
  const rows = [
    { id: 'm0', top: -500, height: 200 },
    { id: 'm1', top: -300, height: 900 },
  ];

  it('measures a loaded row, viewport-relative', () => {
    const el = scroller({ scrollTop: 500, scrollHeight: 10_000, clientHeight: 800, rows });
    expect(domScrollSurface(() => el).rowBox('m1')).toEqual({ top: -300, height: 900 });
  });

  // This is the whole SEEKING state's precondition: a row we do not have cannot
  // place anyone, and the alternative to saying so is inventing a position.
  it('is null for a row that is not loaded', () => {
    const el = scroller({ scrollTop: 500, scrollHeight: 10_000, clientHeight: 800, rows });
    expect(domScrollSurface(() => el).rowBox('ancient')).toBeNull();
  });
});

describe('setScrollTop — the one writer', () => {
  it('assigns, and survives having no element', () => {
    const el = scroller({ scrollTop: 0, scrollHeight: 10_000, clientHeight: 800 });
    domScrollSurface(() => el).setScrollTop(1234);
    expect(el.scrollTop).toBe(1234);
    expect(() => domScrollSurface(() => null).setScrollTop(1)).not.toThrow();
  });
});

describe('beforeEach hygiene', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  it('leaves no nodes behind', () => {
    expect(document.body.children).toHaveLength(0);
  });
});
