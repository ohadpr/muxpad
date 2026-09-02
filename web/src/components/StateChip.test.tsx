import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaneStatus } from '@muxpad/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StateChip } from './StateChip';

/**
 * The row's state encoding is a THREE-part mapping — left bar, row tint, right
 * chip — and only the third part is markup. So this file tests both halves:
 * the chip's DOM (rendered to static markup: no DOM library, and the
 * assertions are about what the browser will actually get) and the CSS
 * contract that paints the other two, read off the stylesheet itself.
 *
 * The CSS assertions are deliberately about the RULES, not about computed
 * pixels: jsdom does not implement color-mix, cascade layers or
 * prefers-reduced-motion, so a computed-style test here would be testing jsdom.
 * The pixels are covered by the Playwright pass, which uses a real engine.
 */
const html = (status: PaneStatus | undefined) =>
  renderToStaticMarkup(<StateChip status={status} />);

const css = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
/** Collapse whitespace so assertions don't depend on the formatter's wrapping. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

const STATE_CSS = flat(css('StateChip.css'));
const NAV_CSS = flat(css('NavTree.css'));
/** The THIRD sheet that styles a nav row — the swipe shell wraps every sheet
 *  tab row and paints its face. Scanned by the shorthand rule below because a
 *  `background:` there resets the tint just as effectively as one written in
 *  NavTree.css, and it is the sheet nobody thinks to look in. */
const SWIPE_CSS = flat(css('SwipeRow.css'));

/** A selector that targets a nav ROW's own box — the element that paints the
 *  tint. Attribute and pseudo-CLASS suffixes still count (`:hover`,
 *  `[data-active]`); a descendant or a pseudo-ELEMENT does not. */
const ROW_BOX =
  /(?:^|\s)\.navtree-(?:tab-row|ws-row|pane-row-wrap)(?:\[[^\]]*\]|:(?!:)[a-z-]+(?:\([^)]*\))?)*$/;

/**
 * Flatten a stylesheet into `{ selectors, body }` rules, INCLUDING the ones
 * nested inside at-rules. A naive `([^{}]+){([^}]*)}` scan silently mis-parses
 * `@media … { .x { … } }` — it reads `.x { display: none;` as a body — so a
 * declaration added inside a media block walks straight past any rule below.
 */
function rules(sheet: string): { selectors: string; body: string }[] {
  const out: { selectors: string; body: string }[] = [];
  const re = /([^{}]+)\{|\}/g;
  let head: string | null = null;
  let start = 0;
  let depth = 0;
  for (let m = re.exec(sheet); m; m = re.exec(sheet)) {
    if (m[0] === '}') {
      if (depth === 1 && head !== null) {
        out.push({ selectors: head, body: sheet.slice(start, m.index) });
        head = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    const sel = (m[1] ?? '').trim();
    depth += 1;
    // An at-rule is a container, not a subject — descend into it.
    if (sel.startsWith('@')) continue;
    head = sel;
    start = re.lastIndex;
  }
  return out;
}

/** Every rule whose subject is a row box AND which sets `background:`. */
function rowRulesUsingBackgroundShorthand(sheet: string): string[] {
  return rules(sheet)
    .filter((r) => /(?:^|[;\s])background:/.test(r.body))
    .filter((r) => r.selectors.split(',').some((sel) => ROW_BOX.test(sel.trim())))
    .map((r) => `${r.selectors} {${r.body}}`);
}

/** Every rule that paints a bar or a tint on a row that is ALSO selected —
 *  the thing the "selection is not a state" exclusion exists to prevent. */
function rulesPaintingStateOnASelectedRow(sheet: string): string[] {
  return rules(sheet)
    .filter((r) => /background(?:-image)?: (?:var\(--state-hue\)|linear-gradient)/.test(r.body))
    .filter((r) =>
      r.selectors
        .split(',')
        .some(
          (sel) =>
            /\.navtree-(?:tab-row|pane-row-wrap)/.test(sel) &&
            !sel.includes(':not([data-active="true"])'),
        ),
    )
    .map((r) => r.selectors);
}

describe('the chip — one telling per state', () => {
  it('working is a SPINNER and no word', () => {
    const h = html('working');
    expect(h).toContain('navtree-state-spin');
    // The word is present but is the reduced-motion twin, and is marked as
    // such — the media query, not JS, decides which one shows.
    expect(h).toContain('navtree-state-word -motion-sub');
    expect(h).toContain('WORKING');
  });

  it('blocked says YOU — the thing it is blocked ON, not its own condition', () => {
    const h = html('blocked');
    expect(h).toContain('>YOU<');
    expect(h).not.toContain('navtree-state-spin');
  });

  it('ready says READY and dead says FAILED', () => {
    expect(html('ready')).toContain('>READY<');
    expect(html('dead')).toContain('>FAILED<');
  });

  it('idle draws nothing at all — and is :empty, so it costs no width', () => {
    const h = html('idle');
    expect(h).toBe('<span class="navtree-state" data-state="idle"></span>');
  });

  it('an UNDEFINED status is idle, not a crash and not a gap', () => {
    expect(html(undefined)).toContain('data-state="idle"');
  });

  it('an UNKNOWN status from a newer server clamps to idle', () => {
    expect(html('done' as never)).toBe('<span class="navtree-state" data-state="idle"></span>');
  });

  it('every state carries the same wrapper, so no row can shift', () => {
    for (const s of ['blocked', 'working', 'ready', 'dead', 'idle'] as const) {
      expect(html(s)).toMatch(/^<span class="navtree-state" data-state="/);
    }
  });
});

describe('the chip — state is never colour-only', () => {
  it('three states carry a WORD; working carries a shape, and a word without motion', () => {
    expect(html('blocked')).toContain('navtree-state-word');
    expect(html('ready')).toContain('navtree-state-word');
    expect(html('dead')).toContain('navtree-state-word');
    expect(html('working')).toContain('navtree-state-spin');
  });

  it('every non-idle row announces its state to a screen reader', () => {
    expect(html('blocked')).toContain('>Waiting on you<');
    expect(html('working')).toContain('>Working<');
    expect(html('ready')).toContain('>Ready for you<');
    expect(html('dead')).toContain('>Agent exited<');
  });

  it('working is announced too, unlike the mark this replaced', () => {
    // The old mark had to be aria-hidden for `working`, because it lived INSIDE
    // the link and its label churned the link's accessible name every time an
    // agent started or stopped.
    expect(html('working')).toContain('navtree-state-sr');
  });

  it('every render site keeps the chip OUT of the row control', () => {
    // Which is what makes the line above safe. Hidden text inside a link or a
    // button joins that control's ACCESSIBLE NAME, so a chip nested in one
    // would rename the control on every state change. Checked against the
    // source because it is a placement rule, and placement is exactly what
    // regressed once (the sheet's pane rows shipped it inside the button).
    const tsx = readFileSync(join(import.meta.dirname, 'NavTree.tsx'), 'utf8');
    const sites = [...tsx.matchAll(/<StateChip[^>]*\/>/g)];
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const site of sites) {
      const before = tsx.slice(0, site.index);
      // The nearest enclosing element must not be a Link or a <button>: find
      // the last opening tag that has not been closed before this point.
      const opens = [...before.matchAll(/<(Link|button)\b/g)];
      const closes = [...before.matchAll(/<\/(Link|button)>/g)];
      expect(opens.length).toBe(closes.length);
    }
  });

  it('idle is silent — there is nothing to say', () => {
    expect(html('idle')).not.toContain('navtree-state-sr');
  });

  it('the visible chip text is hidden from AT, so nobody hears "YOU"', () => {
    expect(html('blocked')).toContain('<span class="navtree-state-word" aria-hidden="true">');
    expect(html('working')).toContain('<span class="navtree-state-spin" aria-hidden="true">');
  });
});

describe('the CSS mapping — hue, bar, tint', () => {
  const HUES: [string, string][] = [
    ['working', '--status-working'],
    ['ready', '--status-ready'],
    ['blocked', '--status-blocked'],
    ['dead', '--status-dead'],
  ];

  it('each state maps to its own hue token, on the row AND on the chip', () => {
    for (const [state, token] of HUES) {
      // One `--state-hue` declaration per state, and the row classes that paint
      // the bar/tint are all in its selector list.
      const rule = new RegExp(
        `\\.navtree-state\\[data-state="${state}"\\][^{]*\\{[^}]*--state-hue: var\\(${token}\\);`,
      );
      expect(STATE_CSS).toMatch(rule);
      for (const row of ['navtree-tab-row', 'navtree-ws-row', 'navtree-pane-row-wrap']) {
        expect(STATE_CSS).toContain(`.${row}[data-state="${state}"]`);
      }
    }
  });

  it('dead is grey and NOT red — a dead runner is not asking for anything', () => {
    expect(STATE_CSS).toContain('.navtree-state[data-state="dead"]');
    expect(STATE_CSS).toMatch(/data-state="dead"[^{]*\{[^}]*--state-hue: var\(--status-dead\);/);
    // …and the FAILED chip is the only word chip whose hue is not one of the
    // three loud ones.
    expect(html('dead')).toContain('>FAILED<');
  });

  it('the bar track is RESERVED on every row and transparent when idle', () => {
    expect(STATE_CSS).toMatch(
      /\.navtree-tab-row::before,[^{]*\{[^}]*width: 3px;[^}]*background: transparent;/,
    );
    // …and painted only when there is a state to paint.
    const painted = rules(STATE_CSS).filter((r) => /background: var\(--state-hue\)/.test(r.body));
    expect(painted).toHaveLength(1);
    expect(painted[0]?.selectors).toContain(
      '.navtree-ws-row[data-state]:not([data-state="idle"])::before',
    );
  });

  it('the tint is a background-IMAGE on the ROW, so a hover fill cannot take it away', () => {
    const tint = rules(STATE_CSS).filter((r) =>
      r.body.includes('background-image: linear-gradient'),
    );
    expect(tint).toHaveLength(1);
    expect(tint[0]?.body.replace(/\s+/g, ' ')).toContain(
      'color-mix(in srgb, var(--state-hue) var(--status-wash), transparent)',
    );
    // …and it is the row box that carries it, not some inner element.
    for (const row of ['navtree-tab-row', 'navtree-ws-row', 'navtree-pane-row-wrap']) {
      expect(tint[0]?.selectors).toContain(`.${row}[data-state]`);
    }
  });

  it('no nav row ever sets the `background` SHORTHAND, which would reset the tint', () => {
    // The failure this pins is invisible in review and obvious on screen: one
    // shorthand on a hover rule and every working row goes flat under the
    // pointer. Rules for things INSIDE a row (its buttons, its icon chip) are
    // fine — only the row's own box paints the tint.
    expect(rowRulesUsingBackgroundShorthand(NAV_CSS)).toEqual([]);
    expect(rowRulesUsingBackgroundShorthand(STATE_CSS)).toEqual([]);
    // SwipeRow.css is the one that had a live offender, and the one no reader
    // of this feature would think to open.
    expect(rowRulesUsingBackgroundShorthand(SWIPE_CSS)).toEqual([]);
  });
});

describe('the CSS mapping — selection is not a state', () => {
  it('the selected row is a SOLID accent block with the accent ink', () => {
    expect(NAV_CSS).toMatch(
      /\.navtree-tab-row\[data-active="true"\] \{ background-color: var\(--accent\); color: var\(--accent-fg\); \}/,
    );
    expect(NAV_CSS).toMatch(
      /\.navtree-pane-row-wrap\[data-active="true"\] \{ background-color: var\(--accent\);/,
    );
  });

  it('a selected row drops BOTH the tint and the bar', () => {
    // …by never painting them, not by overriding afterwards. Written as an
    // override it LOSES the cascade — `[data-state]:not([data-state="idle"])`
    // is two attribute selectors against `[data-active="true"]`'s one — and the
    // bar and the wash land on top of the solid block. Regression, seen on
    // screen before it was seen in review.
    for (const row of ['navtree-tab-row', 'navtree-pane-row-wrap']) {
      for (const suffix of ['::before', '']) {
        const paint = new RegExp(
          `\\.${row}\\[data-state\\]:not\\(\\[data-state="idle"\\]\\):not\\(\\[data-active="true"\\]\\)${suffix} ?[,{]`,
        );
        expect(STATE_CSS).toMatch(paint);
      }
    }
    // A workspace row is the exception, and deliberately: nothing fills an
    // active workspace header, so there is nothing for a tint to collide with.
    expect(STATE_CSS).toContain('.navtree-ws-row[data-state]:not([data-state="idle"])::before');
    // And nothing ANYWHERE re-paints a bar or a tint onto a selectable row
    // without that exclusion — the exclusion existing is not the same claim as
    // the exclusion being the only rule that paints.
    expect(rulesPaintingStateOnASelectedRow(`${STATE_CSS} ${NAV_CSS} ${SWIPE_CSS}`)).toEqual([]);
  });

  it('…but KEEPS its chip, re-inked against the block', () => {
    expect(STATE_CSS).toMatch(
      /\[data-active="true"\] \.navtree-state-word,[^{]*\{[^}]*color: var\(--accent-fg\); \}/,
    );
  });

  it('SELECTED + WORKING still spins — in the block ink, not amber', () => {
    // The one chat whose progress matters most must not be the one row that
    // loses its signal. Shape and motion are untouched; only the colour moves.
    expect(STATE_CSS).toMatch(
      /\[data-active="true"\] \.navtree-state-spin,[^{]*\{ border-color: color-mix\(in srgb, var\(--accent-fg\) 30%, transparent\); border-top-color: var\(--accent-fg\); \}/,
    );
    // …and NOTHING anywhere in the sheet stops or hides a spinner on a selected
    // row. Checked over every rule, not a window of characters after the one
    // selector — a `display: none` added a little further down would have sat
    // outside a window and inside the bug.
    const silenced = rules(STATE_CSS).filter(
      (r) =>
        /\.navtree-state-spin/.test(r.selectors) &&
        /(?:animation: none|display: none)/.test(r.body) &&
        !r.selectors.startsWith('@'),
    );
    for (const r of silenced) {
      // The only legitimate one is the reduced-motion swap, which hands the
      // state to the WORKING word in the same breath.
      expect(STATE_CSS.slice(0, STATE_CSS.indexOf(r.selectors))).toContain(
        '@media (prefers-reduced-motion: reduce)',
      );
    }
  });
});

describe('only WORKING moves', () => {
  it('the rail declares exactly ONE animation, and it is the spinner', () => {
    const animations = [...`${STATE_CSS} ${NAV_CSS}`.matchAll(/animation: ([^;]+);/g)].map(
      (m) => m[1],
    );
    expect(animations).toEqual(['navtree-state-spin 0.8s linear infinite']);
  });

  it('the spinner is a 13px ring on a 2px stroke, turning once every 0.8s', () => {
    expect(STATE_CSS).toMatch(
      /\.navtree-state-spin \{[^}]*width: 13px;[^}]*border: 2px solid[^}]*animation: navtree-state-spin 0\.8s linear infinite;/,
    );
  });
});

describe('reduced motion substitutes a WORD, never a fainter mark', () => {
  // Bounded to the media block itself. Slicing to end-of-file made every
  // assertion below silently also an assertion about whatever came after it.
  const start = STATE_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  const block = STATE_CSS.slice(start, STATE_CSS.indexOf('} }', start) + 3);

  it('the spinner is replaced by the labelled chip', () => {
    expect(block).toMatch(/\.navtree-state-spin \{ display: none; \}/);
    expect(block).toMatch(/\.navtree-state-word\.-motion-sub \{ display: inline-block; \}/);
  });

  it('the substitute is the SAME chip as the other three states', () => {
    // `-motion-sub` adds nothing but the display toggle — so WORKING lands in
    // the identical box READY and YOU use, rather than in a bespoke one.
    const declarations = [...STATE_CSS.matchAll(/\.navtree-state-word\.-motion-sub \{([^}]*)\}/g)]
      .map((m) => m[1]?.trim())
      .sort();
    expect(declarations).toEqual(['display: inline-block;', 'display: none;']);
  });

  it('nothing is dimmed or hidden outright — the state is still stated', () => {
    expect(block).not.toContain('opacity');
    expect(block).not.toContain('visibility: hidden');
  });
});
