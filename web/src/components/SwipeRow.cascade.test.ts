import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A sheet row's OWN fill must survive a SHUFFLE of the stylesheets.
 *
 * ─── The defect this pins ────────────────────────────────────────────────
 * Four rules set `background-color` on the same element on mobile, and all
 * four were (0,2,0) — one class + one attribute, or two classes:
 *
 *   NavTree.css   .navtree-tab-row[data-active="true"]    { … var(--accent)   }
 *   NavTree.css   .navtree-tab-row[data-pressing="true"]  { … var(--bg-hover) }
 *   NavTree.css   .navtree-tab-row:hover                  { … var(--bg-hover) }
 *   SwipeRow.css  .swiperow-face .navtree-tab-row         { … transparent     }
 *
 * A dead heat is settled by SOURCE ORDER, and the first three won only because
 * `NavTree.tsx` imports `./SwipeRow` (and with it SwipeRow.css) above its own
 * `./NavTree.css`. Nothing declares that dependency. Sorting the import block,
 * moving the SwipeRow import, or a bundler emitting the two sheets into
 * differently-ordered chunks would each have turned the selected chat
 * transparent on every phone, and no test would have noticed.
 *
 * ─── Why the assertions are written this way ─────────────────────────────
 * Asserting that SwipeRow.css *contains* a `:not(…)` would restate the fix
 * rather than test it. So this loads the REAL sheets into jsdom in BOTH
 * orders — including the one that loses a tie — and asks the cascade what each
 * row is painted.
 *
 * jsdom has no layout engine, but it does have a cascade, and cascade is the
 * whole subject here. It does not resolve custom properties, so a winning
 * `var(--accent)` comes back as the literal string, which is a perfectly good
 * marker for "that rule won".
 *
 * ─── One thing this harness CANNOT see, so do not trust it blindly ───────
 * jsdom scores a rule by the MAX specificity across its whole selector LIST,
 * where a browser scores the branch that actually matched. `.a[x], .b .c[x]`
 * is (0,2,0) against a `.a[x]` element in a browser and (0,3,0) in jsdom — and
 * `.navtree-tab-row[data-pressing="true"]` is exactly that shape (NavTree.css
 * groups it with a heavier sheet selector).
 *
 * That blind spot is why an earlier draft of the fix passed here and was still
 * wrong: `:not([data-active="true"])` alone lifted the swipe rule to (0,3,0),
 * which out-ranked `[data-pressing]` and `:hover` and killed the long-press
 * fill on every unselected sheet row. The rule now MISSES those rows instead
 * of out-ranking them, which is order- AND arithmetic-independent, so this
 * harness is sound for it — but the next cascade fix should not assume a green
 * run here means the specificity maths was checked.
 */

const css = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');

/**
 * Mount both sheets in the given order, plus one swipeable sheet row, and
 * return the resolved `background-color` of the active and idle rows.
 */
function paint(order: 'nav-last' | 'swipe-last'): { active: string; idle: string } {
  const nav = `<style>${css('NavTree.css')}</style>`;
  const swipe = `<style>${css('SwipeRow.css')}</style>`;
  document.head.innerHTML = order === 'swipe-last' ? nav + swipe : swipe + nav;
  // The mobile sheet's shape: a swipe shell wrapping the face, and the tab
  // rows inside it. Only the attributes the rules key on matter.
  document.body.innerHTML = `
    <div class="navtree" data-variant="sheet">
      <div class="swiperow">
        <div class="swiperow-face">
          <div id="active" class="navtree-tab-row" data-active="true"></div>
        </div>
      </div>
      <div class="swiperow">
        <div class="swiperow-face">
          <div id="idle" class="navtree-tab-row"></div>
        </div>
      </div>
    </div>`;
  const bg = (id: string) =>
    getComputedStyle(document.getElementById(id) as HTMLElement).backgroundColor;
  return { active: bg('active'), idle: bg('idle') };
}

/** Every `selector { body }` in a sheet, comments stripped, at-rules skipped. */
function topLevelRules(sheet: string): { selectors: string[]; body: string }[] {
  const clean = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selectors: string[]; body: string }[] = [];
  const depth: string[] = [];
  const re = /([^{}]*)([{}])/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const head = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    if (m[2] === '}') {
      depth.pop();
      continue;
    }
    if (head.startsWith('@')) {
      depth.push(head);
      continue;
    }
    const close = clean.indexOf('}', re.lastIndex);
    const body = clean.slice(re.lastIndex, close === -1 ? undefined : close);
    if (depth.length === 0) {
      out.push({ selectors: head.split(',').map((s) => s.replace(/\s+/g, ' ').trim()), body });
    }
    depth.push(head);
  }
  return out;
}

/**
 * Every NavTree.css selector branch of the shape `.navtree-tab-row<qualifiers>`
 * — the row itself, with no ancestor part — that sets `background-color`.
 *
 * This is the list the swipe rule has to skip, DERIVED rather than transcribed,
 * so a fourth painting rule added to NavTree.css fails the test below instead
 * of silently losing to the swipe face.
 */
function rowPaintQualifiers(): string[] {
  const found = new Set<string>();
  for (const r of topLevelRules(css('NavTree.css'))) {
    if (!/(?:^|;)\s*background-color\s*:/.test(r.body)) continue;
    for (const sel of r.selectors) {
      const m = sel.match(/^\.navtree-tab-row((?:\[[^\]]*\]|:[a-z-]+)*)$/);
      const q = m?.[1];
      if (q) found.add(q);
    }
  }
  return [...found];
}

/** jsdom's spelling of `transparent` once it has been through the cascade. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

describe('the mobile selected row is accent-filled regardless of sheet order', () => {
  it('keeps the accent when SwipeRow.css is loaded LAST', () => {
    // The order that loses on a tie, and therefore the whole test. Today's
    // build happens to produce the other one.
    const { active } = paint('swipe-last');
    expect(active).not.toBe(TRANSPARENT);
    expect(active).toContain('--accent');
  });

  it('keeps the accent when NavTree.css is loaded last', () => {
    // The order the app currently ships. Asserted too, so the pair together
    // says "order does not decide this" rather than "the other order works".
    const { active } = paint('nav-last');
    expect(active).not.toBe(TRANSPARENT);
    expect(active).toContain('--accent');
  });

  it('still clears the fill on a RESTING row, in both orders', () => {
    // The guard must not have been bought by disabling the rule. A resting row
    // inside the sliding face is still transparent, so the face's own surface
    // is what shows and the row does not read as a full-bleed band the moment
    // it moves.
    expect(paint('swipe-last').idle).toBe(TRANSPARENT);
    expect(paint('nav-last').idle).toBe(TRANSPARENT);
  });
});

describe('the swipe face skips every row NavTree paints, not just the active one', () => {
  /**
   * The half jsdom cannot check, done by reading the sheets instead.
   *
   * The first draft of the fix guarded only `[data-active="true"]`, which
   * out-ranked `[data-pressing]` and `:hover` at (0,2,0) and deleted the
   * long-press fill from every unselected sheet row — the only rows it can
   * appear on, since `useLongPress` ignores mouse and pen and touch rows are
   * always inside a swipe face. The cascade tests above CANNOT see that:
   * jsdom scores a rule by the max specificity across its whole selector list,
   * and NavTree.css groups `[data-pressing]` with a heavier sheet selector, so
   * in jsdom it wins either way.
   *
   * So this reads the required list out of NavTree.css and checks the swipe
   * rule against it. Deriving it is the point — transcribing the three
   * qualifiers here would pass forever after someone adds a fourth.
   */
  const EXEMPT = new Set([
    // Drop targets are gated to `variant === 'sidebar'` in NavTree.tsx, so a
    // row carrying this attribute is never inside a swipe face.
    '[data-drop-into="true"]',
    // Subsumed: excluding `[data-active="true"]` already excludes the row this
    // matches.
    '[data-active="true"]:hover',
  ]);

  it('names every background-color rule NavTree.css puts on the row', () => {
    const swipeRule = topLevelRules(css('SwipeRow.css')).find((r) =>
      r.selectors.some((s) => s.includes('.swiperow-face') && s.includes('.navtree-tab-row')),
    );
    expect(swipeRule).toBeDefined();
    const selector = (swipeRule as { selectors: string[] }).selectors.join(',');

    const qualifiers = rowPaintQualifiers();
    // The parse found something; an empty list would make every assertion
    // below vacuously true.
    expect(qualifiers.length).toBeGreaterThanOrEqual(3);
    for (const q of qualifiers) {
      if (EXEMPT.has(q)) continue;
      expect(
        selector,
        `NavTree.css paints .navtree-tab-row${q}; the swipe face must skip it`,
      ).toContain(q);
    }
  });
});
