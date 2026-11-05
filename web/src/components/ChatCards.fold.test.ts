import { describe, expect, it } from 'vitest';
import { SELF_MEASURE } from './ChatCards';

/**
 * WHERE A FOLDED HTML CARD IS CUT.
 *
 * Reported as cards that "end up showing cropped content, either their own
 * line is cropped or the next line starts showing and it's cropped" — which
 * is two symptoms of one cause: a fold height computed from ONE element's box
 * is a guess about where the next element begins. A pixel of descender or
 * line-height overflow shaves the kept row; a collapsed margin reveals the
 * top of the next one, which is worse, because cropped content looks like
 * content the card is trying to show.
 *
 * ── WHY THIS TEST LOOKS LIKE THIS ────────────────────────────────────────
 * The rule lives in a string of JavaScript that runs inside a sandboxed frame
 * (no app imports, no shared code), and jsdom has no layout engine — every
 * `getBoundingClientRect()` in it is 0×0. So the script is evaluated here
 * against boxes this test chooses. It is the only way to check the
 * arithmetic at all, and it checks the arithmetic rather than a screenshot.
 */

interface Box {
  top: number;
  bottom: number;
  height: number;
}

/** One element in the fake layout. */
interface El {
  box: Box;
  children?: El[];
  peek?: boolean;
}

/**
 * Run the in-frame script against a layout, and return the `h1` it reports.
 *
 * `h` (the full height) is the body's own box; `h1` is the fold height, which
 * is the thing under test.
 */
function measure(bodyBox: Box, paddingTop: number, els: El[]): number {
  const node = (el: El, parent: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      getBoundingClientRect: () => el.box,
      parentElement: parent,
      nextElementSibling: null,
      firstElementChild: null,
    };
    const kids = (el.children ?? []).map((k) => node(k, self));
    kids.forEach((k, i) => {
      k.nextElementSibling = kids[i + 1] ?? null;
    });
    self.firstElementChild = kids[0] ?? null;
    self.__peek = el.peek === true;
    self.__kids = kids;
    return self;
  };
  const top = { getBoundingClientRect: () => bodyBox } as Record<string, unknown>;
  const nodes = els.map((e) => node(e, top));
  nodes.forEach((n, i) => {
    n.nextElementSibling = nodes[i + 1] ?? null;
  });
  const flat: Record<string, unknown>[] = [];
  const walk = (list: Record<string, unknown>[]) => {
    for (const n of list) {
      flat.push(n);
      walk((n.__kids as Record<string, unknown>[]) ?? []);
    }
  };
  walk(nodes);
  const body = {
    ...top,
    firstElementChild: nodes[0] ?? null,
    scrollHeight: bodyBox.height,
    querySelector: (sel: string) =>
      sel === '[data-peek]' ? (flat.find((n) => n.__peek) ?? null) : null,
  };
  let reported = 0;
  const sandbox = {
    document: {
      body,
      querySelector: () => null,
      // No fonts object: the `document.fonts &&` guard covers it, and this
      // test is about the arithmetic rather than the re-measure schedule.
    },
    getComputedStyle: () => ({ paddingTop: `${paddingTop}px` }),
    parent: {
      postMessage: (m: { h1: number }) => {
        reported = m.h1;
      },
    },
    addEventListener: () => {},
    requestAnimationFrame: () => {},
    setTimeout: () => {},
    window: {} as Record<string, unknown>,
    Infinity,
    Math,
    parseFloat,
  };
  // The script is wrapped in a <script> tag for the frame; strip it.
  const body_js = SELF_MEASURE.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');
  const fn = new Function(...Object.keys(sandbox), body_js);
  fn(...Object.values(sandbox));
  return reported;
}

const BODY: Box = { top: 0, bottom: 300, height: 300 };

describe('the fold height', () => {
  it('never shaves the kept row, even when the next one starts immediately', () => {
    // A collapsed margin: the next element's top IS the kept element's bottom.
    // The cut lands exactly there — all of the kept row, none of the next.
    const h1 = measure(BODY, 10, [
      { box: { top: 10, bottom: 34, height: 24 }, peek: true },
      { box: { top: 34, bottom: 58, height: 24 } },
    ]);
    expect(h1).toBe(34);
  });

  it('never reveals the next row, even though it would rather be symmetric', () => {
    // The mirrored top inset (10px) would put the cut at 44 and show 6px of
    // the next row. Not revealing it wins.
    const h1 = measure(BODY, 10, [
      { box: { top: 10, bottom: 34, height: 24 }, peek: true },
      { box: { top: 38, bottom: 62, height: 24 } },
    ]);
    expect(h1).toBe(38);
  });

  it('mirrors the top inset when the gap is wide enough', () => {
    // 10px of air above, 10px below, and the next row still 20px away.
    const h1 = measure(BODY, 10, [
      { box: { top: 10, bottom: 34, height: 24 }, peek: true },
      { box: { top: 64, bottom: 88, height: 24 } },
    ]);
    expect(h1).toBe(44);
  });

  it('takes the whole card when there is nothing below the kept row', () => {
    // One element: folded and open are the same, which is what "a
    // single-element card measures the same either way" means.
    const h1 = measure(BODY, 10, [{ box: { top: 10, bottom: 34, height: 24 }, peek: true }]);
    expect(h1).toBe(44);
  });

  it('finds the next row from OUTSIDE a wrapper the mark is nested in', () => {
    // `[data-peek]` on a row inside a header div has no sibling worth
    // reading; the next thing that will actually appear is the wrapper's own
    // next sibling. Guessing from the mark alone is how a wrapped card showed
    // a cropped second row.
    const h1 = measure(BODY, 10, [
      {
        box: { top: 10, bottom: 34, height: 24 },
        children: [{ box: { top: 10, bottom: 34, height: 24 }, peek: true }],
      },
      { box: { top: 36, bottom: 60, height: 24 } },
    ]);
    expect(h1).toBe(36);
  });

  it('falls back to the first element with a box when nothing is marked', () => {
    // An unmarked card still folds, without ceremony — and a leading <style>
    // tag (0×0) must not become the thing it folds to.
    const h1 = measure(BODY, 10, [
      { box: { top: 10, bottom: 10, height: 0 } },
      { box: { top: 10, bottom: 34, height: 24 } },
      { box: { top: 40, bottom: 64, height: 24 } },
    ]);
    expect(h1).toBe(40);
  });
});
