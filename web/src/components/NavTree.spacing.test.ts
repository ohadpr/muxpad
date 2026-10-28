import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The nav row's geometry, pinned. TWO surfaces, and they no longer share a
 * model.
 *
 * ─── Read this first: the sheet forked ───────────────────────────────────
 * Everything under "the row spacing scale" and "gap 1/2/3" below describes the
 * DESKTOP RAIL: a four-track grid whose columns have to land on one x, held
 * together by a three-step scale (4 / 8 / 12). That model still governs the
 * rail, and — because they are still grid/flex rows built from the same tokens
 * — the sheet's WORKSPACE-PICKER and PANE rows.
 *
 * It does NOT govern the sheet's CHAT rows any more. Those were rebuilt as a
 * flex line with two fixed points and no columns to align, on its own
 * four-number scale (--nt-rail-*), and they are pinned in their own describe
 * block at the bottom of this file. Where a test below used to loop over both
 * variants and now loops over the rail only, that is why — a sheet arm that
 * kept passing by reading a base rule the sheet overrides would be worse than
 * no arm at all.
 *
 * ─── Why this file exists ────────────────────────────────────────────────
 * Two spacing defects shipped past review and past a passing test suite, and
 * both were invisible to any assertion about a DECLARATION, because both were
 * declarations that said the right thing and did nothing:
 *
 *   1. the state chip sat 4px from the row's right edge — on the selected row,
 *      4px from a solid accent block's rounded corner, which reads as touching;
 *   2. the icon chip had `margin-right: var(--nt-gutter)` and a gap of 2.00px,
 *      because --nt-col-icon was a FIXED 22px track around a 20px chip, and a
 *      fixed grid track does not grow for its item's margin. The margin was
 *      dead the day it was written.
 *
 * So this file asserts the ARITHMETIC of the row, not the presence of rules.
 * It reads the tokens out of the stylesheet, resolves them, and computes the
 * three gaps a reader actually sees — then checks each against its floor. A
 * declaration that stops taking effect changes the arithmetic and fails here.
 *
 * ─── What it cannot do, and what covers that ─────────────────────────────
 * jsdom has no layout engine, so nothing here is a real measurement. The
 * arithmetic below is a MODEL of the row, and the model was checked against a
 * real Chromium against the real app before it was written down — every number
 * this file computes was observed to 0.00px:
 *
 *   rail  (280px, 1280×900)   chip→row edge 12.00 · icon chip→first glyph
 *                             12.00 · name track→chip 12.00
 *   sheet (390×844)           14.00 · 14.00 · 14.00
 *
 * The two frozen positions were also checked and were unchanged: across all
 * six rail rows the state bar sat at x=8 and the icon chip's left edge at x=20,
 * with 0.00px of spread (sheet: 12 and 36). Frozen means the row's own INSET,
 * not an absolute x — a sheet PANE row's bar did move 12px right, because the
 * pane list's indent follows the tab name and the tab name moved 12px right.
 * Moving together is the invariant; see the hierarchy-step test below.
 *
 * If the model and the browser ever disagree, the browser is right and the
 * model is the bug.
 */

const css = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const NAV_CSS = css('NavTree.css');
const STATE_CSS = css('StateChip.css');

/** Collapse whitespace so nothing here depends on the formatter's wrapping. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * Every `{ selectors, body, atRules }` in a sheet, comments stripped.
 *
 * Brace-counted rather than regex-matched. A `([^{}]+)\{([^{}]*)\}` scan cannot
 * match an at-rule's outer block at all: it walks past the `@media {` and hands
 * back the rule NESTED inside it as if it were top-level — so a
 * `@media (max-width: …) { .navtree-tab-row { padding-right: 99px } }` would be
 * silently merged into the real rule and could even win the lookup. Nothing in
 * these two sheets does that today; the parser refusing to be fooled is cheap,
 * and this file exists because of a thing that was true "today".
 */
function rules(sheet: string): { selectors: string[]; body: string; atRules: string[] }[] {
  const clean = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selectors: string[]; body: string; atRules: string[] }[] = [];
  const stack: string[] = [];
  const re = /([^{}]*)([{}])/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const head = flat(m[1] ?? '').trim();
    if (m[2] === '}') {
      stack.pop();
      continue;
    }
    if (head.startsWith('@')) {
      stack.push(head);
      continue;
    }
    // A rule's body runs to its own closing brace; rules never nest here.
    const close = clean.indexOf('}', re.lastIndex);
    out.push({
      selectors: head.split(',').map((s) => flat(s).trim()),
      body: flat(clean.slice(re.lastIndex, close === -1 ? undefined : close)),
      atRules: [...stack],
    });
    stack.push(head);
  }
  return out;
}

/**
 * The body of the rule whose selector list contains `selector` exactly, at the
 * sheet's TOP level. Matching the whole selector (not a prefix) is what keeps
 * `.navtree` from picking up `.navtree-tab-row`; matching inside the LIST is
 * what lets a grouped rule (`.a > .x, .b > .x { … }`) be addressed by either
 * arm; and refusing to look inside at-rules is what stops a media query from
 * answering a question about the base cascade.
 */
function ruleBody(sheet: string, selector: string): string {
  const hits = rules(sheet).filter((r) => r.atRules.length === 0 && r.selectors.includes(selector));
  if (hits.length === 0) throw new Error(`no rule for selector: ${selector}`);
  return hits.map((r) => r.body).join(' ');
}

/**
 * `prop: value;` out of a rule body — the LAST one, because that is the one the
 * cascade keeps. (`decl(body, 'padding')` on a body that sets `padding` twice
 * must answer with the winner, not the loser.)
 */
function decl(body: string, prop: string): string {
  const all = [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))];
  if (all.length === 0) throw new Error(`no declaration: ${prop}`);
  return ((all[all.length - 1] as RegExpMatchArray)[1] ?? '').trim();
}

/**
 * Split a shorthand into its terms, respecting nesting — `calc(a + var(b))` is
 * ONE term. A `calc\([^)]*\)` regex stops at the inner `)` and silently hands
 * back half an expression, which is the kind of quiet wrongness this whole file
 * is about.
 */
function terms(shorthand: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of shorthand.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** One side of a `padding:` / `margin:` shorthand, with CSS's own fill rules. */
function side(shorthand: string, which: 'top' | 'right' | 'bottom' | 'left'): string {
  const t = terms(shorthand);
  const [a, b = a, c = a, d = b] = t as [string, string?, string?, string?];
  return { top: a, right: b as string, bottom: c as string, left: d as string }[which];
}

/** `+ - * /` over parenthesised numbers. Written out rather than eval'd. */
function arithmetic(src: string): number {
  const tok = src.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  let i = 0;
  const peek = () => tok[i];
  const primary = (): number => {
    const t = tok[i++];
    if (t === '(') {
      const v = sum();
      if (tok[i++] !== ')') throw new Error(`unbalanced: ${src}`);
      return v;
    }
    if (t === '-') return -primary();
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${String(t)} in ${src}`);
    return n;
  };
  const product = (): number => {
    let v = primary();
    while (peek() === '*' || peek() === '/') v = tok[i++] === '*' ? v * primary() : v / primary();
    return v;
  };
  function sum(): number {
    let v = product();
    while (peek() === '+' || peek() === '-') v = tok[i++] === '+' ? v + product() : v - product();
    return v;
  }
  const value = sum();
  if (i !== tok.length) throw new Error(`trailing input: ${src}`);
  return value;
}

/**
 * Resolve a CSS length expression against a token map — `var()`, `calc()` and
 * plain `Npx`. Deliberately tiny: it exists so the test computes the same
 * number the engine does, from the same source, rather than restating it.
 */
function resolve(expr: string, tokens: Record<string, string>, depth = 0): number {
  if (depth > 12) throw new Error(`var() cycle in: ${expr}`);
  const substituted = expr.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) => {
    const v = tokens[name];
    if (v === undefined) throw new Error(`unknown token: ${name}`);
    return `(${resolve(v, tokens, depth + 1)})`;
  });
  const arith = substituted.replace(/calc\(/g, '(').replace(/px/g, '');
  // A length only. `0` is a length; `auto`, `1fr`, `50%` and `minmax(…)` are
  // not, and must fail loudly rather than resolve to something plausible.
  if (!/^[\d\s().+\-*/]+$/.test(arith)) throw new Error(`not a length: ${expr}`);
  const n = arithmetic(arith);
  if (!Number.isFinite(n)) throw new Error(`not finite: ${expr}`);
  return n;
}

/** Every `--nt-*` declared in a rule. */
function tokensOf(sheet: string, selector: string): Record<string, string> {
  const body = ruleBody(sheet, selector);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--nt-[\w-]+):\s*([^;]+)/g))
    out[m[1] as string] = (m[2] as string).trim();
  return out;
}

const BASE = tokensOf(NAV_CSS, '.navtree');
const SHEET = { ...BASE, ...tokensOf(NAV_CSS, '.navtree[data-variant="sheet"]') };

const VARIANTS: [name: string, tokens: Record<string, string>][] = [
  ['rail', BASE],
  ['sheet', SHEET],
];
/** The rail alone — for the gaps whose model the sheet's chat rows left. */
const RAIL: [name: string, tokens: Record<string, string>][] = [['rail', BASE]];

/** The sheet's chat-row rule, addressed once so every arm reads the same body. */
const SHEET_ROW = '.navtree[data-variant="sheet"] .navtree-tab-row';

/** One side of a two-value LOGICAL shorthand (`padding-inline: start end`),
 *  with CSS's own one-value fill. */
function logical(shorthand: string, which: 'start' | 'end'): string {
  const t = terms(shorthand);
  const [a, b = a] = t as [string, string?];
  return which === 'start' ? a : (b as string);
}

/**
 * The right-hand inset of a row kind, as the engine computes it — the SHORTHAND
 * and the longhand resolved in source order, because a `padding:` written after
 * a `padding-right:` resets it and preferring the longhand unconditionally
 * would report a value the browser never uses.
 */
function paddingRight(selector: string, tokens: Record<string, string>): number {
  const body = ruleBody(NAV_CSS, selector);
  let value: string | null = null;
  for (const m of body.matchAll(/(?:^|;)\s*(padding|padding-right):\s*([^;]+)/g)) {
    const raw = (m[2] as string).trim();
    value = m[1] === 'padding' ? side(raw, 'right') : raw;
  }
  if (value === null) throw new Error(`no padding on ${selector}`);
  return resolve(value, tokens);
}

/**
 * A grid row's `column-gap`, which is charged between EVERY pair of adjacent
 * tracks whether or not the track between them has content — so it is part of
 * every horizontal gap in the row and cannot be left out of the model. The tab
 * row sets it to 0 for exactly that reason and pays its gutters as item
 * margins; the workspace row keeps 4px. `0` when the rule does not set it.
 */
function columnGap(selector: string, tokens: Record<string, string>): number {
  const body = ruleBody(NAV_CSS, selector);
  if (!/(?:^|;)\s*(?:column-)?gap:/.test(body)) return 0;
  const raw = /(?:^|;)\s*column-gap:/.test(body)
    ? decl(body, 'column-gap')
    : // `gap: <row> <column>`, or one value for both.
      (terms(decl(body, 'gap'))[1] ?? terms(decl(body, 'gap'))[0] ?? '0');
  return resolve(raw, tokens);
}

describe('the row spacing scale — three steps, and which gap gets which', () => {
  it('is exactly three steps, ordered, off a 4px base', () => {
    for (const [name, t] of VARIANTS) {
      const pad = resolve(t['--nt-pad'] as string, t);
      const gutter = resolve(t['--nt-gutter'] as string, t);
      const air = resolve(t['--nt-air'] as string, t);
      expect({ name, pad }).toEqual({ name, pad: 4 });
      // Strictly increasing: if air ever collapses onto the gutter the two
      // anchors stop being anchors and the row is flat again.
      expect(pad).toBeLessThan(gutter);
      expect(gutter).toBeLessThan(air);
    }
  });

  it('air is at least 12px in BOTH variants — the floor the defect broke', () => {
    for (const [name, t] of VARIANTS) {
      expect({ name, air: resolve(t['--nt-air'] as string, t) >= 12 }).toEqual({
        name,
        air: true,
      });
    }
  });

  it('the shipped steps are rail 4/8/12 and sheet 4/10/14', () => {
    const steps = ([, t]: [string, Record<string, string>]) =>
      (['--nt-pad', '--nt-gutter', '--nt-air'] as const).map((k) => resolve(t[k] as string, t));
    expect(steps(VARIANTS[0] as [string, Record<string, string>])).toEqual([4, 8, 12]);
    expect(steps(VARIANTS[1] as [string, Record<string, string>])).toEqual([4, 10, 14]);
  });
});

describe('gap 1 — the state chip clears the row’s right edge', () => {
  // The defect: 4px, which on the selected row is 4px from a solid accent
  // block's border-radius and reads as touching it. Every row kind that draws
  // a chip has to clear it, and by the same amount, or the chips stop sharing
  // a column.
  const KINDS = ['.navtree-tab-row', '.navtree-ws-row', '.navtree-pane-row-wrap'];

  it('every row kind insets its tail by one step of AIR — except the one that cannot', () => {
    for (const [name, t] of RAIL) {
      const air = resolve(t['--nt-air'] as string, t);
      for (const kind of KINDS) {
        // The WORKSPACE row is the exception, and it is arithmetic rather than
        // taste: it charges a 4px `column-gap` before its (usually empty) state
        // track where a tab row charges none, so the SAME token puts the two
        // tails on DIFFERENT x. Measured with air on both: the header's × ended
        // at 240 against the chat rows' marks at 246 — two columns 6px apart
        // pretending to be one, which is what "the + and × can be more to the
        // right" was describing. 6px is what lands them together.
        if (kind === '.navtree-ws-row') {
          expect({ name, kind, gap: paddingRight(kind, t) }).toEqual({ name, kind, gap: 6 });
          continue;
        }
        expect({ name, kind, gap: paddingRight(kind, t) }).toEqual({ name, kind, gap: air });
        expect(paddingRight(kind, t)).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('…and the sheet’s pane row still pays it', () => {
    // The workspace-picker row and the pane row are still built from this
    // scale; only the CHAT row left it, and now the rail's workspace header.
    const air = resolve(SHEET['--nt-air'] as string, SHEET);
    expect(paddingRight('.navtree-pane-row-wrap', SHEET)).toBe(air);
  });
  it('the pane row’s inset is on the WRAP, which is the box that paints the block', () => {
    // On the list it was outside the accent block and bought the block nothing.
    expect(ruleBody(NAV_CSS, '.navtree-pane-row-wrap')).toContain('padding-right: var(--nt-air)');
    const list = ruleBody(NAV_CSS, '.navtree-pane-list');
    expect(decl(list, 'padding').split(/\s+/)[1]).toBe('0');
  });
});

describe('gap 2 — the icon chip clears the name', () => {
  it('the icon TRACK is derived from the chip, never a literal', () => {
    // The bug class, pinned: a literal track and a margin on the item are two
    // numbers that can disagree, and the margin is the one that loses.
    expect(decl(ruleBody(NAV_CSS, '.navtree'), '--nt-col-icon')).toBe(
      'calc(var(--nt-chip) + var(--nt-air))',
    );
    // …and no variant may re-fix it.
    expect(tokensOf(NAV_CSS, '.navtree[data-variant="sheet"]')).not.toHaveProperty('--nt-col-icon');
  });

  it('nothing puts a MARGIN on the icon — inside a fixed track it is dead', () => {
    const clean = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const offenders = rules
      .filter(([, sel]) => /\.navtree-tab-icon\s*(?:,|$)/.test((sel as string).trim()))
      .filter(([, , body]) =>
        /(?:^|[;\s])margin(?:-right|-left|-inline[\w-]*)?:/.test(body as string),
      )
      .map(([, sel]) => (sel as string).trim());
    expect(offenders).toEqual([]);
  });

  it('the gap from the chip’s right edge to the name is one step of AIR', () => {
    // Rail only: the sheet's chat row has no icon TRACK at all now — its emoji
    // is a fixed flex item and the gap is the row's own `gap` property. See
    // the mobile-rail block at the bottom.
    for (const [name, t] of RAIL) {
      const track = resolve(t['--nt-col-icon'] as string, t);
      const chip = resolve(t['--nt-chip'] as string, t);
      const air = resolve(t['--nt-air'] as string, t);
      expect({ name, gap: track - chip + columnGap('.navtree-tab-row', t) }).toEqual({
        name,
        gap: air,
      });
      expect(track - chip).toBeGreaterThanOrEqual(12);
    }
  });

  it('…and the chip is at the track’s HEAD, which is what makes that true', () => {
    // `track − chip` is the visual gap only because the icon box is exactly the
    // chip's width and is placed at the track's START. Flip it to
    // `justify-self: end` and the slack moves to the LEFT of the chip: the gap
    // to the name goes to 0 — the shipped defect, restored — while every number
    // this file computes stays put. Pinned because it is the load-bearing
    // assumption of the whole model, not because anyone is likely to write it.
    const icon = ruleBody(NAV_CSS, '.navtree-tab-icon');
    expect(decl(icon, 'width')).toBe('var(--nt-chip)');
    expect(decl(icon, 'justify-self')).toBe('start');
    expect(ruleBody(NAV_CSS, '.navtree-tab-icon::before')).toContain('width: var(--nt-chip)');
  });

  it('the name cell adds no inset of its own, so the track IS the gap', () => {
    // If the title line ever grew a padding-left the computed gap above would
    // stop being the gap on screen — which is exactly how the 2px hid.
    for (const sel of ['.navtree-tab-link', '.navtree-tab-titleline', '.navtree-name-text']) {
      const body = ruleBody(NAV_CSS, sel);
      expect(body).not.toMatch(/(?:^|;)\s*(?:padding|padding-left|margin|margin-left):/);
    }
  });
});

describe('gap 3 — a truncated name never crowds the chip', () => {
  // What sits in front of the chip is an ellipsised name that stops wherever
  // the truncation lands, so this gap is the worst case on every long row —
  // and at the gutter step the `…` and the word chip read as one run.
  //
  // The gap the eye sees is the chip's own margin PLUS the row's column-gap,
  // which grid charges between every pair of adjacent tracks. Tab rows set that
  // gap to 0 and pay per item (so the number is exactly air); the workspace row
  // keeps its 4px, so its chip leads by air + 4. Both clear the floor, and the
  // chips still share a right edge — that is the column, and it is set by the
  // row's padding, not by this.
  const LEADING: [selector: string, row: string | null][] = [
    ['.navtree-tab-row > .navtree-state:not(:empty)', '.navtree-tab-row'],
    ['.navtree-ws-row > .navtree-state:not(:empty)', '.navtree-ws-row'],
    // The pane wrap is a FLEX row with no gap; the margin is the whole gap.
    ['.navtree-pane-row-wrap > .navtree-state:not(:empty)', null],
  ];

  it('clears the 12px floor on every row kind, in both variants', () => {
    for (const [selector, row] of LEADING) {
      const margin = decl(ruleBody(NAV_CSS, selector), 'margin-left');
      for (const [name, t] of VARIANTS) {
        const gap = resolve(margin, t) + (row ? columnGap(row, t) : 0);
        expect({ selector, name, ok: gap >= 12 }).toEqual({ selector, name, ok: true });
      }
    }
  });

  it('is exactly AIR on the tab and pane rows — the two with no column-gap', () => {
    for (const [selector, row] of LEADING) {
      if (row === '.navtree-ws-row') continue;
      const margin = decl(ruleBody(NAV_CSS, selector), 'margin-left');
      for (const [name, t] of RAIL) {
        const gap = resolve(margin, t) + (row ? columnGap(row, t) : 0);
        expect({ selector, name, gap }).toEqual({
          selector,
          name,
          gap: resolve(t['--nt-air'] as string, t),
        });
      }
    }
  });

  it('an IDLE chip still declines the space, so idle rows keep their width', () => {
    // The `:not(:empty)` is the whole reason moving the mark off the right edge
    // paid for itself. A blanket margin here would charge every idle row again.
    // `\b` would not do: it fires before a hyphen, so `.navtree-state-word`
    // would satisfy the guard and a rule on the CELL could slip past.
    const cells = rules(NAV_CSS).filter(
      (r) =>
        r.selectors.some((s) => />\s*\.navtree-state(?![\w-])/.test(s)) &&
        /(?:^|;)\s*margin-left:/.test(r.body),
    );
    // Not vacuous: three row kinds declare it, in one grouped rule plus one.
    expect(cells.length).toBeGreaterThan(0);
    for (const r of cells) {
      for (const sel of r.selectors) {
        if (!/>\s*\.navtree-state(?![\w-])/.test(sel)) continue;
        expect(sel).toContain(':not(:empty)');
      }
    }
  });
});

describe('what the pass was NOT allowed to move', () => {
  // A precise claim, because the loose one is false: the bar's INSET from its
  // own row box is frozen at 4px on every row kind and both variants. Its
  // absolute x is not a constant and never was — it is 8 on the rail, 12 on the
  // sheet, and on a sheet PANE row it moved 12px right with this pass, because
  // the pane list's indent follows the tab name and the tab name moved 12px
  // right. That the two moved together is the hierarchy-step test below; that
  // is the invariant, not "nothing moved".
  it('the state bar’s inset is still the 4px hairline step', () => {
    // The left edge is the rail's scan line. It is named now (--nt-pad) rather
    // than a literal, but the number is frozen.
    // Asserted as a RESOLVED length, not as a spelling: naming it is a
    // readability win, but the thing that must not change is the pixel.
    for (const arm of [
      '.navtree-tab-row::before',
      '.navtree-ws-row::before',
      '.navtree-pane-row-wrap::before',
    ]) {
      for (const [name, t] of VARIANTS) {
        expect({ arm, name, x: resolve(decl(ruleBody(STATE_CSS, arm), 'left'), t) }).toEqual({
          arm,
          name,
          x: 4,
        });
      }
    }
  });

  it('the icon chip’s LEFT edge is unmoved: pad + indent, and the chip at 0', () => {
    // 0.00px of spread across every row in the tree was the hard-won property
    // of the icon column; it is a consequence of these two numbers plus the
    // chip pseudo-element's `left: 0`, and of nothing else.
    const left = side(decl(ruleBody(NAV_CSS, '.navtree-tab-row'), 'padding'), 'left');
    expect(left).toBe('calc(var(--nt-pad) + var(--nt-indent))');
    expect(resolve(left, BASE)).toBe(16); // rail: 4 + 12
    expect(ruleBody(NAV_CSS, '.navtree-tab-icon::before')).toContain('left: 0');
  });

  it('the sheet’s pane list keeps its 18px hierarchy step under the chat name', () => {
    // Derived, because as a literal (64px) it silently shrank to a 6px step the
    // moment the icon track grew — children reading as siblings.
    //
    // The DERIVATION changed with the rail rebuild and the step did not: a chat
    // name used to start at `pad + disclosure + icon-track`, and now starts at
    // `lead + emoji + gap`, because the leading disclosure column is gone. Both
    // expressions are read out of the sheet's own rules here, so the step
    // cannot drift again the next time either side moves.
    const listLeft = decl(
      ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-pane-list'),
      'padding-inline-start',
    );
    const paneRowPad = side(decl(ruleBody(NAV_CSS, '.navtree-pane-row'), 'padding'), 'left');
    const paneLabelLeft = resolve(listLeft, SHEET) + resolve(paneRowPad, SHEET);
    expect(paneLabelLeft - chatNameLeft()).toBe(18);
  });

  it('the RAIL’s row height is the CHIP’s, and every row is the same height', () => {
    // The rail's row is ONE LINE now — name only, the headline having moved to
    // the row's tooltip — so the tallest thing in it is no longer a stack of
    // text: it is the 24px chip, which is a real element (it clips the clock's
    // fill) and therefore does enter the row's height.
    //
    // What this test defends did not change with the number: --nt-row-tab must
    // be EXACTLY the padding plus the tallest item, or the row is floor-clamped
    // by its min-height and the vertical rhythm comes from two places at once.
    // Air must never appear in the vertical padding for the same reason.
    const railPad = decl(ruleBody(NAV_CSS, '.navtree-tab-row'), 'padding');
    expect(resolve(side(railPad, 'top'), BASE)).toBe(6);
    expect(resolve(side(railPad, 'bottom'), BASE)).toBe(6);
    // 6 + 24 + 6 = 36, exactly --nt-row-tab.
    expect(6 + resolve(BASE['--nt-chip'] as string, BASE) + 6).toBe(
      resolve(BASE['--nt-row-tab'] as string, BASE),
    );
  });

  it('rename input and row padding fit without increasing the chat row height', () => {
    const rename = ruleBody(NAV_CSS, '.navtree-rename');
    expect(decl(rename, 'box-sizing')).toBe('border-box');
    const inputHeight = resolve(decl(rename, 'height'), BASE);
    const pad = decl(ruleBody(NAV_CSS, '.navtree-tab-row'), 'padding');
    expect(
      inputHeight + resolve(side(pad, 'top'), BASE) + resolve(side(pad, 'bottom'), BASE),
    ).toBeLessThanOrEqual(resolve(BASE['--nt-row-tab'] as string, BASE));
    expect(resolve(decl(rename, 'height'), SHEET)).toBeLessThanOrEqual(
      resolve(SHEET['--nt-row-tab'] as string, SHEET),
    );
  });

  it('the rail’s chip sits at its track’s HEAD, like the plate it replaced', () => {
    // Same load-bearing assumption as the icon plate above, restated for the
    // element that is actually rendered on the rail: the gap to the name is
    // `track − chip` only while the chip is at the track's START. The chip's
    // own width comes from --chatchip-size in ChatChip.css, which is the same
    // 24 as --nt-chip; the alignment is this file's business.
    expect(
      decl(ruleBody(NAV_CSS, '.navtree[data-variant="sidebar"] .navtree-tab-chip'), 'justify-self'),
    ).toBe('start');
  });

  it('a CHILD row takes NO step — the ELBOW says "under that one", not the indent', () => {
    // This test used to pin an 8px step, and before that a full --nt-indent.
    // Both were the same idea — move the name right so the eye reads a level —
    // and on this surface the idea is wrong, because the rail ALREADY spends a
    // 24px column on every child: the icon cell, kept precisely so the names
    // line up, with the trunk's elbow landing inside it. An indent on top of
    // that is a second statement of one fact, paid for with a fifth left
    // column in a group that measured four (caret 32, trunk 28, parent name
    // 63, child name 71).
    //
    // THIS TEST WAS INERT AND PASSING for three reviews: the rule is correct,
    // and `data-child="true"` was emitted on no element in the product, because
    // `renderRow` never forwarded `parent` to `TabRow`. A stylesheet test cannot
    // see that. Its other half is NavTree.rows.test.tsx, which renders the list
    // and asserts the attribute and the dot actually reach the DOM — do not
    // change this selector without it, or the pair goes dead again.
    const child = ruleBody(
      NAV_CSS,
      '.navtree[data-variant="sidebar"] .navtree-tab-row[data-child="true"]',
    );
    const parentLeft = resolve(
      side(decl(ruleBody(NAV_CSS, '.navtree-tab-row'), 'padding'), 'left'),
      BASE,
    );
    expect(resolve(decl(child, 'padding-left'), BASE)).toBe(parentLeft);
  });

  it('…so every name in the rail lands on ONE x, parent or child', () => {
    // The invariant the step was trading away, stated directly.
    // --nt-child-name-x is the token the tick, the group head's caret and the
    // agent glyph all derive from, so if this moves they move with it.
    const parentLeft = resolve(
      side(decl(ruleBody(NAV_CSS, '.navtree-tab-row'), 'padding'), 'left'),
      BASE,
    );
    const parentName = parentLeft + resolve(BASE['--nt-col-icon'] as string, BASE);
    expect(resolve(BASE['--nt-child-name-x'] as string, BASE)).toBe(parentName);
  });

  it('the group head has no row of its own to align — it is a PILL now', () => {
    // This used to assert the head's caret stood on the trunk, 15/2 back from
    // --nt-trunk-x, so an open group read as one vertical with a control at
    // the top of it. The control moved onto the PARENT's row: the caret, the
    // agent glyph, the total and the breakdown cost a whole row of a 240px
    // rail (a 40px band on the phone) for a group that is usually one or two
    // children — "it feels like we're just wasting space now".
    // So the alignment this guarded no longer exists, and what replaces it is
    // that the rule does not either: a stylesheet keeping a dead selector is
    // how a layout grows a second answer to one question.
    expect(NAV_CSS).not.toMatch(/\.navtree-subs-head\b/);
    expect(NAV_CSS).not.toMatch(/\.navtree-subs-(?:glyph|total|detail|noun)\b/);
  });

  it('the pill is a status object, and takes the channel’s own wash', () => {
    // A pill and a state mark of the same state must be the same colour on
    // every theme, which is the status channel's whole rule — see styles.css.
    // It names no colour of its own and no theme-tuned accent.
    const pill = ruleBody(NAV_CSS, '.navtree-row-pill');
    expect(decl(pill, 'background')).toContain('--status-chip-wash');
    expect(decl(pill, 'background')).toContain('--pill-hue');
    for (const state of ['working', 'ready', 'blocked', 'dead']) {
      const body = ruleBody(NAV_CSS, `.navtree-subs-pill[data-state="${state}"]`);
      expect(body.replace(/\s/g, '')).toBe(`--pill-hue:var(--status-${state});`);
    }
    expect(pill).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(pill).not.toMatch(/--accent|--danger/);
  });

  it('…and it sits one CONTENT gutter from whatever precedes it', () => {
    // The row's own scale, not a number of its own: --nt-gutter is the step
    // between two content columns, and the pill is one.
    expect(decl(ruleBody(NAV_CSS, '.navtree-row-pill'), 'margin-left')).toBe('var(--nt-gutter)');
  });

  it('the rail has ONE disclosure shape, and the glyph is what differs', () => {
    // Two hierarchies — panes inside a chat, chats under a chat — and they
    // were both bare carets until one became a counted pill. Leaving the other
    // a naked chevron made a difference in KIND read as a bug. Same base, two
    // modifiers; the pane one never takes a state hue, because the row's own
    // mark one cell along is already saying what the chat is doing.
    expect(NAV_CSS).toMatch(/\.navtree-pane-pill\b/);
    expect(NAV_CSS).not.toMatch(/\.navtree-pane-expander\b/);
    for (const state of ['working', 'ready', 'blocked', 'dead']) {
      expect(NAV_CSS).not.toMatch(new RegExp(`\\.navtree-pane-pill\\[data-state="${state}"\\]`));
    }
  });

  it('the tick stops 8px short of the name it points at, by arithmetic', () => {
    // It was a literal 24px, correct for a child name at 60 and wrong the
    // moment that moved. Now it cannot disagree with the column it measures to.
    const trunk = resolve(BASE['--nt-trunk-x'] as string, BASE);
    const nameX = resolve(BASE['--nt-child-name-x'] as string, BASE);
    expect(resolve(BASE['--nt-tick-w'] as string, BASE)).toBe(nameX - trunk - 8);
  });

  it('the trunk is drawn in ONE ink, and it is the token', () => {
    // With the indent gone the line is the only thing saying "under that one",
    // so it is load-bearing and gets a name. 18% read as nothing on a tinted
    // dark rail and snapped to a 1px line at DPR 1 — "the lines don't look
    // good".
    const trunkRule = ruleBody(NAV_CSS, '.navtree .navtree-tab-row[data-child="true"]::before');
    const tickRule = ruleBody(NAV_CSS, '.navtree .navtree-tab-row[data-child="true"]::after');
    expect(decl(trunkRule, 'border-left')).toContain('var(--nt-trunk-ink)');
    expect(decl(tickRule, 'border-top')).toContain('var(--nt-trunk-ink)');
    expect(BASE['--nt-trunk-ink']).toContain('26%');
  });
});

/** Where a chat name's first glyph lands on the sheet, from the row's own edge:
 *  the leading inset, the fixed emoji box, and the one gap between them. */
function chatNameLeft(): number {
  return (
    resolve(SHEET['--nt-rail-lead'] as string, SHEET) +
    resolve(SHEET['--nt-rail-emoji'] as string, SHEET) +
    resolve(SHEET['--nt-rail-gap'] as string, SHEET)
  );
}

describe('the MOBILE RAIL — a flex line, and its four numbers', () => {
  // The sheet's chat row is not the rail's row at thumb height any more. It has
  // no columns to align, so it has no three-step scale; it has two fixed points
  // (the emoji and the trailing mark) and a name between them, and these four
  // tokens describe it completely.
  const ROW = () => ruleBody(NAV_CSS, SHEET_ROW);

  it('declares exactly the four numbers, and they are 14 / 20 / 8 / 12', () => {
    const t = tokensOf(NAV_CSS, '.navtree[data-variant="sheet"]');
    expect({
      lead: resolve(t['--nt-rail-lead'] as string, SHEET),
      emoji: resolve(t['--nt-rail-emoji'] as string, SHEET),
      gap: resolve(t['--nt-rail-gap'] as string, SHEET),
      trail: resolve(t['--nt-rail-trail'] as string, SHEET),
    }).toEqual({ lead: 14, emoji: 20, gap: 8, trail: 12 });
  });

  it('the row is EXACTLY 44px — the touch floor, and not a floor with slack', () => {
    // NavTree.spacing's old sheet arm pinned 44 as a MINIMUM under a 46px
    // nominal row, so one-line and two-line rows had different leading. There
    // is one row shape now, so there is one number: block-size and
    // min-block-size are both it, and it is the floor exactly.
    const h = resolve(SHEET['--nt-rail-h'] as string, SHEET);
    expect(h).toBe(44);
    expect(resolve(decl(ROW(), 'block-size'), SHEET)).toBe(h);
    expect(resolve(decl(ROW(), 'min-block-size'), SHEET)).toBe(h);
    // Nothing may put vertical padding back on it — that is what used to make
    // the row taller than the token said.
    expect(resolve(decl(ROW(), 'padding-block'), SHEET)).toBe(0);
  });

  it('every row’s insets and gap come from the tokens, never a literal', () => {
    const pad = decl(ROW(), 'padding-inline');
    expect(resolve(logical(pad, 'start'), SHEET)).toBe(14);
    expect(resolve(logical(pad, 'end'), SHEET)).toBe(12);
    expect(resolve(decl(ROW(), 'gap'), SHEET)).toBe(8);
    // LOGICAL properties throughout: this list is read in Hebrew as often as in
    // English, and a physical inset would put the emoji on the wrong side of an
    // RTL row.
    expect(ROW()).not.toMatch(/(?:^|;)\s*padding(?:-left|-right|-top|-bottom)?:/);
  });

  it('the emoji is a FIXED box at the head of the row, with no plate behind it', () => {
    // Fixed, because emoji advance widths differ (a variation selector adds
    // one) and an auto box moves the name's x a pixel or two per row.
    const icon = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-icon');
    expect(decl(icon, 'flex')).toBe('0 0 var(--nt-rail-emoji)');
    expect(resolve(decl(icon, 'inline-size'), SHEET)).toBe(20);
    // The plate is deleted. It is load-bearing on the rail (emoji ink coverage
    // runs 11%–48%, so a glyph's edge is not a column edge) and it is a mark on
    // EVERY row, which is the one thing this list refuses.
    expect(ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-icon::before')).toContain(
      'content: none',
    );
    // The 1px optical lift — emoji artwork sits low against a Latin baseline.
    expect(resolve(decl(icon, 'inset-block-start'), SHEET)).toBe(-1);
  });

  it('that box now holds the CHIP, scaled to it, so the phone runs the same clock', () => {
    // The cell is unchanged — same class, same 20px box, same lift, same deleted
    // plate — and what sits in it is the rail's own component (NavTree.tsx). That
    // is why the four numbers above still hold after the convergence: the chip is
    // sized BY this rule rather than bringing its own 24px box.
    const icon = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-icon');
    // 17/20 and 15/20 are A2's 20/24 and 18/24 at this surface's scale — and 17px
    // is the size this sheet's emoji has always rendered at, so convergence
    // changes nothing visible on a fresh row and adds the clock to an aged one.
    expect(decl(icon, '--chatchip-glyph')).toBe('17px');
    expect(decl(icon, '--chatchip-glyph-last')).toBe('15px');
    // RESTATED, not inherited, and that is the point: `.chatchip` and
    // `.navtree-tab-icon` are both one class, so which display wins would be
    // decided by the order two stylesheets happen to be bundled in. This rule
    // carries the variant and cannot lose.
    expect(decl(icon, 'display')).toBe('inline-grid');
    expect(decl(icon, 'place-items')).toBe('center');
  });

  it('so every name starts at 42px, on every row, in every script', () => {
    expect(chatNameLeft()).toBe(42);
  });

  it('a CHILD row steps ONE indent — 54px, not 76 — and its dot holds the column', () => {
    // The sheet had no child row at all: TabList emptied `children` before the
    // DOM, so a sub-chat came out as a top-level line above its own parent. Both
    // halves are pinned — the attribute and the dot in NavTree.rows.test.tsx,
    // the arithmetic here.
    //
    // 8px, NOT a full --nt-indent. Both surfaces took a whole step until the
    // trunk arrived; with a line drawing the relationship the extra 4px only
    // pushes the name further from the elbow pointing at it. The rail made the
    // same move for the same reason — see the desktop child rule.
    //
    // The ceiling the old comment guarded still stands and is what matters:
    // indenting by a whole emoji box puts the name 34px off its parent's, which
    // is the "indentation is too much" this rail was once redrawn to fix. So
    // the assertion is a RANGE — clearly stepped, clearly under one level —
    // rather than a number that has now been retuned twice.
    const child = ruleBody(
      NAV_CSS,
      '.navtree[data-variant="sheet"] .navtree-tab-row[data-child="true"]',
    );
    const childLead = resolve(decl(child, 'padding-inline-start'), SHEET);
    const step = childLead - resolve(SHEET['--nt-rail-lead'] as string, SHEET);
    expect(step).toBeGreaterThanOrEqual(6);
    expect(step).toBeLessThan(resolve(SHEET['--nt-indent'] as string, SHEET));
    // The dot's BOX must stay the emoji's box even though the mark itself is now
    // hidden — the trunk says "child", and a dot where the elbow lands is a
    // second mark for one meaning. If the box collapsed, every child name would
    // jump 14px left and the shared x this rule exists to hold would be gone.
    const dot = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-rail-dot');
    expect(decl(dot, 'flex')).toBe('0 0 var(--nt-rail-emoji)');
    expect(resolve(decl(dot, 'inline-size'), SHEET)).toBe(20);
    expect(decl(dot, 'visibility')).toBe('hidden');
    // Logical, like every other inset on this surface: the list is read in
    // Hebrew as often as in English and a physical inset indents the wrong side.
    expect(child).not.toMatch(/(?:^|;)\s*padding(?:-left|-right):/);
  });

  it('there is no leading disclosure track left to push that 42 anywhere', () => {
    // It used to be charged to every row — chevron-less rows carried an
    // identical-width spacer to keep the column — and it put the emoji, the
    // rail's one hard leading edge, 24px in.
    expect(NAV_CSS).not.toMatch(/navtree-pane-expander\.-spacer/);
    expect(ROW()).not.toMatch(/grid-template-columns/);
  });

  it('SELECTION is a full-bleed band: no radius on the row OR on its swipe shell', () => {
    // An inset pill is itself a floating object, and a list whose one surface
    // floats teaches the eye that the rows float too. The radius also has to
    // leave the SHELL: it clips, and a rounded clip cuts a square band's own
    // corners off — and it was what let the swipe tray's red Close block bleed
    // through as a column of ticks down the list's edge.
    expect(resolve(decl(ROW(), 'border-radius'), SHEET)).toBe(0);
    expect(
      resolve(
        decl(ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .swiperow'), 'border-radius'),
        SHEET,
      ),
    ).toBe(0);
    // …and the scroller stops insetting the rows, or "full bleed" is a lie.
    const scroll = decl(
      ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-scroll'),
      'padding',
    );
    expect(resolve(side(scroll, 'left'), SHEET)).toBe(0);
    expect(resolve(side(scroll, 'right'), SHEET)).toBe(0);
  });
});

describe('the MOBILE RAIL — the bidi fix, which is why it is a flex line', () => {
  /**
   * The shipped defect: `dir="auto"` on a name inside a box with SLACK. `dir`
   * sets the CSS `direction`; `direction` is what `text-align`'s initial
   * `start` resolves against; and `flex: 1` hands a five-character Hebrew name
   * a 250px box to be aligned inside. Measured on the shipped sheet: the first
   * glyphs of sixteen names spread over 280px of a 390px rail.
   *
   * These assert the MECHANISM, because the mechanism is the surprising part —
   * the two obvious fixes were measured and rejected (see the CSS). The pixels
   * are measured in a real engine by the Playwright pass; jsdom has no layout.
   */
  it('the name’s box is `flex: 0 1 auto` — it fits its own text, with no slack', () => {
    const link = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-link');
    expect(decl(link, 'flex')).toBe('0 1 auto');
    expect(decl(link, 'min-inline-size')).toBe('0');
  });

  it('the auto margin is on the MARKS, never on the name', () => {
    // This is the whole trap: `margin-inline-end: auto` on a name whose
    // dir="auto" resolved to rtl maps to margin-LEFT and re-creates the
    // original bug wearing a logical property. The marks are never dir="auto",
    // so their inline-start is the row's leading edge, always.
    expect(decl(ruleBody(NAV_CSS, '.navtree-rail-tail'), 'margin-inline-start')).toBe('auto');
    for (const sel of [
      '.navtree[data-variant="sheet"] .navtree-tab-link',
      '.navtree[data-variant="sheet"] .navtree-tab-link .navtree-name-text',
    ]) {
      expect(ruleBody(NAV_CSS, sel)).not.toMatch(/margin[\w-]*:\s*[^;]*auto/);
    }
  });

  it('ONE auto margin, on a wrapper — two would share the free space', () => {
    // Flexbox distributes free space equally across every auto margin on the
    // line, so a chevron and a dot each carrying one would float apart into the
    // middle of the row. The wrapper is why the trailing group is one object.
    const autos = rules(NAV_CSS).filter(
      (r) =>
        r.atRules.length === 0 &&
        /(?:^|;)\s*margin-inline-start:\s*auto/.test(r.body) &&
        r.selectors.some((s) => /rail-tail|rail-mark|navtree-state|pane-expander/.test(s)),
    );
    expect(autos.map((r) => r.selectors.join(','))).toEqual(['.navtree-rail-tail']);
  });

  it('does NOT pin alignment — the pinned version is the one that failed', () => {
    // `text-align: left` is the desktop rail's fix and is correct THERE (its
    // name sits in a 1fr grid track). Here it would be a no-op that hid the
    // real mechanism, and `text-align: start` is the thing that was measured
    // NOT to work: `start` resolves against the plaintext-derived paragraph
    // direction, so the Hebrew still flew to the trailing edge.
    const name = ruleBody(
      NAV_CSS,
      '.navtree[data-variant="sheet"] .navtree-tab-link .navtree-name-text',
    );
    expect(decl(name, 'text-align')).toBe('unset');
    expect(name).not.toMatch(/unicode-bidi/);
    expect(name).not.toMatch(/direction:\s*ltr/);
  });

  it('the row stays tappable end to end despite the name’s box stopping at its text', () => {
    // A shrink-wrapped name on a 390px row would leave most of the row dead.
    // The link is stretched over the row by a zero-ink pseudo-element, and the
    // things that need their own taps are lifted above it.
    const stretch = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-link::after');
    expect(stretch).toContain('position: absolute');
    expect(stretch).toContain('inset: 0');
    // It must paint NOTHING, or it is a mark on every row.
    expect(stretch).toMatch(/content:\s*""/);
    expect(stretch).not.toMatch(/background/);
    for (const sel of ['.navtree[data-variant="sheet"] .navtree-tab-icon', '.navtree-rail-tail']) {
      expect(decl(ruleBody(NAV_CSS, sel), 'z-index')).toBe('1');
    }
  });
});

/**
 * ARCHIVE is not destructive, and the cascade has to agree.
 *
 * The archive button borrows `.navtree-close` for its geometry and then has to
 * take the MEANING back out — `.navtree-close:hover` paints `--danger`. Whether
 * the override actually lands is a specificity question, and specificity is
 * exactly the kind of thing that is invisible to inspection and survives review:
 * the first version of this lost on the selected row ONLY, because the danger
 * rule carries a `:not(.navtree-pin)` worth one extra point.
 */
describe('the row’s × archives, and never reads as delete', () => {
  /** Specificity as (ids, classes+attrs+pseudo-classes, types), CSS's own rules. */
  function specificity(selector: string): [number, number, number] {
    const s = selector.replace(/:not\(([^)]*)\)/g, ' $1 '); // :not() contributes its ARG
    const ids = (s.match(/#[\w-]+/g) ?? []).length;
    const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?!\()/g) ?? []).length;
    const types = (s.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
    return [ids, classes, types];
  }
  const beats = (a: string, b: string) => {
    const [x, y] = [specificity(a), specificity(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) > (y[i] as number);
    return null; // a tie — source order decides, and ours is declared later
  };

  it('overrides the danger hover on an ORDINARY row', () => {
    const danger = '.navtree-close:hover';
    const ours = '.navtree-archive:hover';
    expect(NAV_CSS).toContain(ours);
    // A tie (null) is fine: ours is declared after. Losing is not.
    expect(beats(danger, ours)).not.toBe(true);
    expect(NAV_CSS.indexOf(ours)).toBeGreaterThan(NAV_CSS.indexOf(danger));
    expect(decl(ruleBody(NAV_CSS, ours), 'color')).toBe('var(--accent)');
  });

  it('overrides it on the ACTIVE row too — the case that was wrong', () => {
    const danger =
      '.navtree-tab-row[data-active="true"] button.navtree-close:not(.navtree-pin):hover';
    const ours =
      '.navtree-tab-row[data-active="true"] button.navtree-archive:not(.navtree-pin):hover';
    expect(NAV_CSS).toContain(ours);
    expect(beats(danger, ours)).not.toBe(true);
    expect(NAV_CSS.indexOf(ours)).toBeGreaterThan(NAV_CSS.indexOf(danger));
    expect(decl(ruleBody(NAV_CSS, ours), 'color')).toBe('var(--accent)');
  });

  it('and the specificity helper itself can tell the two apart', () => {
    // Guards the guard: if this ever reports the losing selector as a tie, the
    // two tests above stop meaning anything.
    expect(
      beats(
        '.navtree-tab-row[data-active="true"] button.navtree-close:not(.navtree-pin):hover',
        '.navtree-tab-row[data-active="true"] button.navtree-archive:hover',
      ),
    ).toBe(true);
  });
});

/**
 * THE RIGHT-HAND SIDE OF A ROW — HOW MANY THINGS MAY BE THERE AT ONCE.
 *
 * Reported with a screenshot: "too many things on the right side of the tab
 * labels. scheduled cron time, spinner, action buttons." Three sources, and
 * they were additive, so the worst row carried a pin, an archive button, a
 * clock, a time and a state mark in a strip about 90px wide — on a 270px rail
 * whose names were already ellipsising.
 *
 * Two of the three are fixed in this sheet and are pinned here, because both
 * are one-selector changes that a later edit could undo without any test
 * noticing. (The third — the cron's nine-character `Thu 11:08` shape — is a
 * label, and lives in next-cron-label.test.)
 */
describe('nothing in the rail animates sideways', () => {
  it('transitions OPACITY and nothing with a width in it', () => {
    // `width`, `flex-basis` and `margin-left` were all animated, so a control
    // slid open horizontally — and the row's name is the flexible track, so
    // every one of those 80ms pushed the NAME too. Running the cursor down the
    // list left a wave of text reflowing behind it, one row at a time.
    // A control appearing is not a journey: it is there or it is not.
    const body = ruleBody(NAV_CSS, '.navtree-close');
    const t = decl(body, 'transition');
    expect(t).toMatch(/opacity/);
    for (const prop of ['width', 'flex-basis', 'margin-left', 'all']) {
      expect(t).not.toMatch(new RegExp(prop));
    }
  });
});

describe('a revealed control never moves one that was already there', () => {
  // THE REPORT: you move the pointer towards the workspace's "+", the row lights
  // up, and the button now under your cursor is the × that deletes the workspace
  // and every tab in it. Measured: "+" at x=240 at rest, x=220 on hover, with ×
  // landing on 240 — a swap from "create a chat" to "destroy a workspace",
  // under a cursor that had not moved.
  //
  // `.navtree-close` collapses to zero width at rest and claims 18px on hover,
  // which is right for the LAST item in a right-aligned group and wrong for
  // every other one. So the slot is reserved and only visibility changes.
  it('reserves the workspace × so the + cannot be displaced', () => {
    const body = ruleBody(
      NAV_CSS,
      '.navtree-ws-row > .navtree-tab-controls > .navtree-close:not(.navtree-ws-add)',
    );
    // The SIZE is a token now (`--nt-ctl`), because the reservation and the
    // reveal have to agree exactly and they used to do it by both spelling
    // "18px" — four call sites of a number that had to match. What this test
    // protects is the reservation existing at the same size as the reveal, so
    // it asserts they name the same token rather than the same digits.
    expect(decl(body, 'width')).toBe('var(--nt-ctl)');
    const revealed = ruleBody(NAV_CSS, '.navtree-tab-row:hover .navtree-close');
    expect(decl(revealed, 'width')).toBe('var(--nt-ctl)');
  });

  it('hides it with VISIBILITY, not opacity — a transparent button still takes the click', () => {
    // The dangerous version of the same bug: a close button you cannot see,
    // sitting in a reserved slot, is a workspace deleted with no warning at all.
    const base = ruleBody(NAV_CSS, '.navtree-close');
    expect(decl(base, 'visibility')).toBe('hidden');
  });

  it('keeps hiding at a specificity every reveal path outranks', () => {
    // This is where it went wrong once: `:has()` carries the specificity of its
    // argument, so a reservation scoped with `:has(.navtree-pin.is-pinned)`
    // (three classes) beat `.navtree-tab-row:hover` (two) — and the archive
    // stayed hidden on the row you were pointing at. Size and visibility are
    // separate rules now: the reservations set width only.
    // Chat rows need no reservation at all now — nothing in their rail is
    // permanent, because the clock LEAVES when the buttons arrive. The one
    // reservation left is the workspace header's ×, and it still sets size only.
    const body = ruleBody(
      NAV_CSS,
      '.navtree-ws-row > .navtree-tab-controls > .navtree-close:not(.navtree-ws-add)',
    );
    expect(decl(body, 'width')).toBe('var(--nt-ctl)');
    expect(body).not.toMatch(/visibility/);
  });

  it('never hides the rail itself — the buttons live in it', () => {
    // A rule here used to collapse the cell on a hovered row with no schedule,
    // written when the cell held only the clock. Once the hover controls moved
    // in beside it, `display: none` took the pin and the archive with them:
    // hovering a pinned chat made both vanish and neither could be clicked.
    const hidden = rules(NAV_CSS).filter(
      (r) => r.atRules.length === 0 && /(?:^|;)\s*display:\s*none/.test(r.body),
    );
    expect(
      hidden.flatMap((r) => r.selectors).filter((s) => /\.navtree-tab-rail$/.test(s.trim())),
    ).toEqual([]);
  });
});

describe('the trailing rail is ONE column, not three', () => {
  // Reported as horizontal "balagan": a pin at x=550 and a clock at x=597 down
  // the same list. The cause was structural — the row spent THREE grid tracks
  // on its right-hand side (hover controls, schedule, state mark), so two
  // indicators in different cells could not share an edge however they were
  // styled. One flex rail, right-aligned, fixed order, and the state mark alone
  // keeping its own track as the scan line.
  // Measured after: every pin and every clock ends at x=226, marks at 246.
  it('puts every indicator in ONE cell', () => {
    const row = ruleBody(NAV_CSS, '.navtree-tab-row');
    // Four tracks now, not five: icon | name | rail | state.
    const cols = decl(row, 'grid-template-columns').split(/\s+(?![^(]*\))/);
    expect(cols).toHaveLength(4);
    // And the retired cells are gone from the tab row entirely.
    const all = rules(NAV_CSS).flatMap((r) => r.selectors);
    expect(all.filter((s) => s.startsWith('.navtree-tab-row') && s.includes('tab-meta'))).toEqual(
      [],
    );
    expect(
      all.filter((s) => s.startsWith('.navtree-tab-row') && s.includes('tab-controls')),
    ).toEqual([]);
  });

  it('charges NOTHING between rail items — the 6px that kept coming back', () => {
    // Twice: once as a flex `gap`, once as a `margin-left` on the item after
    // the clock. Both land on the zero-width archive button, and space given to
    // a zero-width item is still space — it pushed every clock 6px left of
    // every pin, which is the same defect one order of magnitude smaller.
    const rail = ruleBody(NAV_CSS, '.navtree-tab-row > .navtree-tab-rail');
    expect(Number.parseFloat(decl(rail, 'gap'))).toBe(0);
    expect(rail).toMatch(/justify-content:\s*flex-end/);
  });

  it('needs NO state-track reservation, because nothing in the rail is permanent', () => {
    // It existed so a clock and a pin on adjacent rows agreed about where the
    // column was while the state mark's own track flickered between 0 and 18px.
    // With the pin hover-only and the clock stepping aside for the buttons, a
    // row shows at most ONE rail item at a time and there is nothing left to
    // keep in line — so the width goes back to the name.
    const all = rules(NAV_CSS).flatMap((r) => r.selectors);
    expect(all.filter((s) => s.includes(':has(.navtree-tab-rail > *)'))).toEqual([]);
  });
});

describe('the row’s right-hand side holds one thing at a time', () => {
  // `:focus-within` is true on the ACTIVE row for as long as you are in that
  // chat, because clicking its link leaves focus there. So the row you were
  // using was the one row permanently wearing its hover controls. The reveal
  // has to key off a KEYBOARD focus, which is what `:focus-visible` means — and
  // the keyboard path must keep working, which is why the selector is replaced
  // rather than deleted.
  it('reveals the controls on hover or a KEYBOARD focus, never on a click', () => {
    const revealing = rules(NAV_CSS).filter(
      (r) => r.atRules.length === 0 && /flex-basis:\s*var\(--nt-ctl\)/.test(r.body),
    );
    expect(revealing.length).toBeGreaterThan(0);
    const tabArms = revealing
      .flatMap((r) => r.selectors)
      .filter((sel) => sel.startsWith('.navtree-tab-row'));
    // Hover still reveals…
    expect(tabArms).toContain('.navtree-tab-row:hover .navtree-close');
    // …and so does a keyboard focus…
    expect(tabArms).toContain('.navtree-tab-row:has(:focus-visible) .navtree-close');
    // …but a plain :focus-within arm is the bug, on any row kind.
    expect(
      revealing.flatMap((r) => r.selectors).filter((s) => s.includes(':focus-within')),
    ).toEqual([]);
  });

  it('steps the WHOLE schedule aside while the controls are out', () => {
    // This asserted the opposite twice, in two directions, and both were right
    // at the time. First the whole cell hid, which made the row under your
    // pointer the only row not saying it had a schedule. Then the glyph was
    // kept and only the time hidden. Then the pin became permanent too, and
    // three icons plus a state slot ate a third of the row — reported as such.
    // A schedule is a standing PROPERTY and the buttons are ACTIONS; the rail
    // shows one kind at a time, which is this block's own title.
    const body = ruleBody(NAV_CSS, '.navtree-tab-row:hover > .navtree-tab-rail > .navtree-cron');
    expect(decl(body, 'display')).toBe('none');
    expect(
      rules(NAV_CSS).some(
        (r) =>
          r.atRules.length === 0 &&
          r.selectors.includes(
            '.navtree-tab-row:has(:focus-visible) > .navtree-tab-rail > .navtree-cron',
          ) &&
          /(?:^|;)\s*display:\s*none/.test(r.body),
      ),
    ).toBe(true);
  });

  it('shows the PIN only on hover — the ROW is what says "pinned"', () => {
    // This has flipped twice and the second flip is the stable one, because the
    // marker finally landed on the right object rather than in the cheapest
    // free space. The pin was ON at rest for one iteration, after the seam rule
    // under the pinned block was deleted and nothing replaced it. It worked —
    // and it cost 18px of name width on exactly the rows pinned because they
    // matter most, which was the original objection to it and was still true.
    //
    // The row's NAME carries a hue now (`--nt-pinned-ink`), which costs no
    // width at all, so the pin goes back to being an action beside the archive.
    const all = rules(NAV_CSS).flatMap((r) => r.selectors);
    const permanent = all.filter(
      (sel) =>
        sel.includes('.navtree-pin.is-pinned') && !sel.includes(':hover') && !sel.includes('focus'),
    );
    // Any rule left for a resting pinned pin may set COLOUR and nothing that
    // gives it a box.
    for (const sel of permanent) {
      const body = ruleBody(NAV_CSS, sel);
      expect(body).not.toMatch(/width|flex|visibility/);
    }
  });

  it('leaves the state mark alone — it is in neither cell and must not move', () => {
    // The mark is the LAST track and the name is the 1fr one, so the name
    // absorbs the whole swap. A `display: none` that ever reached the mark, or
    // a width on the meta cell that the mark had to share, would put the one
    // thing you scan down the rail onto a different x for the row you happen to
    // be pointing at.
    const hoverRail = ruleBody(NAV_CSS, '.navtree-tab-row:hover > .navtree-tab-rail');
    expect(hoverRail).not.toMatch(/navtree-mark/);
    expect(decl(ruleBody(NAV_CSS, '.navtree-tab-row'), 'grid-template-columns')).toContain(
      'minmax(0, 1fr)',
    );
  });
});

/**
 * THE RAIL'S HORIZONTAL GUTTER, WHICH TWO SURFACES WERE DERIVING SEPARATELY.
 *
 * A row's inset is composed: the scroller's padding, plus the group's. The
 * search box is not in the group, so it restates the sum in its own margin —
 * and it restated it BACKWARDS, 4 left / 8 right against the rows' 8 / 4. Its
 * comment said it was "matching the scroller's own left/right insets so the box
 * lines up with the rows under it", which is the tell: the rule that says what
 * it is for is the rule that stopped doing it. Measured in Chromium at 280px:
 * search 4…272, rows 8…276. Reported as "the search bar doesn't have equal
 * margins".
 *
 * Asserted as ARITHMETIC against the same tokens, not as a literal pair, so the
 * two cannot drift apart again when the gutter changes.
 */
/**
 * THE SEARCH BUTTON IS NOT ON THE ROWS' EDGES, BECAUSE IT IS NOT A ROW.
 *
 * It was an inline field, then a button wearing that field's clothes, then a
 * slimmed-down row — all three aligned to the rows below them, because all
 * three owned a row at the top of the rail. "You don't search there, it's
 * just a hotkey reminder, maybe it doesn't need to take up so much space."
 * It rides the brand row now: an icon in the left third of a row that already
 * exists, which is zero rows and no alignment to inherit.
 */
describe('the search button costs the rail no row', () => {
  const search = ruleBody(NAV_CSS, '.navtree-search');

  it('is a square icon button, not a labelled bar', () => {
    expect(decl(search, 'width')).toBe('28px');
    expect(decl(search, 'height')).toBe('28px');
  });

  it('renders no label and no key cap', () => {
    // The chord moved into the tooltip, which is where a reminder you have
    // already learned belongs.
    expect(NAV_CSS).not.toMatch(/\.navtree-search-label/);
    expect(NAV_CSS).not.toMatch(/\.navtree-search-kbd/);
  });

  it('leaves the rows where they were — this removed a box, not a list', () => {
    const scroll = ruleBody(NAV_CSS, '.navtree-scroll');
    const group = ruleBody(NAV_CSS, '.navtree-group');
    const inset = (which: 'left' | 'right') =>
      resolve(side(decl(scroll, 'padding'), which), BASE) +
      resolve(side(decl(group, 'padding'), which), BASE);
    expect([inset('left'), inset('right')]).toEqual([8, 4]);
  });
});

/**
 * THE RAIL NEVER SCROLLS SIDEWAYS.
 *
 * The ACTIVE tab deliberately bleeds `--nt-pad` past the group's padding so it
 * touches the pane rather than stopping a hair short of it — and with the
 * scroller's x axis left visible, that 4px bleed was a real horizontal
 * scrollbar: measured scrollWidth 284 against clientWidth 280, and
 * `scrollLeft = 50` landing at 4 instead of 0. The bleed is exactly flush with
 * the rail's edge, so clipping it costs nothing visible (checked: the active
 * row's right edge is 280 with the clip, same as without).
 *
 * `clip`, not `hidden`, so there is no x-axis scrollport to script or rubber-
 * band at all — with `hidden` the overflow is still scrollable programmatically
 * and still a scroll container, which is how an "unscrollable" list ends up
 * 4px off to one side.
 */
describe('nothing in the rail scrolls sideways', () => {
  const scroll = ruleBody(NAV_CSS, '.navtree-scroll');

  it('clips the x axis', () => {
    expect(decl(scroll, 'overflow-x')).toBe('clip');
  });

  it('keeps a `hidden` ahead of it for engines that do not know `clip`', () => {
    const all = [...scroll.matchAll(/(?:^|;)\s*overflow-x:\s*([^;]+)/g)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(all).toEqual(['hidden', 'clip']);
  });

  it('still bleeds the active row out to the rail edge — the clip is flush', () => {
    const active = ruleBody(NAV_CSS, '.navtree-tab-row[data-active="true"]');
    const group = ruleBody(NAV_CSS, '.navtree-group');
    expect(resolve(decl(active, 'margin-right'), BASE)).toBe(
      -resolve(side(decl(group, 'padding'), 'right'), BASE),
    );
  });
});

/**
 * THE ACTIVE ROW'S FUNNEL IS A NODE, NOT A THIRD CLAIM ON `::after`.
 *
 * The two concave fillets that flare the pane's surface into the row you are
 * in lived in `::after` — and so does the tree elbow on a SUB-CHAT row, at
 * higher specificity (`.navtree .navtree-tab-row[data-child]` is (0,3,0)
 * against (0,2,0)). The child rule therefore won, but it only sets
 * `left`/`top`/`width`/`border-top`, so the box kept the fillet's `right`,
 * `bottom: -18px` and radial gradients and painted a blob below and left of
 * the row. Reported as "the active chat rounded indicator thing is bust".
 *
 * This file's own fillet comment is the record of the FIRST time two things
 * were given one pseudo-element — `::before`, shared with StateChip's left
 * track, where the over-constrained box silently dropped `right`. Same defect,
 * same file, one pseudo along.
 */
describe('the active row’s funnel', () => {
  it('is its own element, so nothing can win it on specificity', () => {
    expect(rules(NAV_CSS).some((r) => r.selectors.includes('.navtree-tab-funnel'))).toBe(true);
  });

  it('leaves `::after` to the sub-chat elbow alone', () => {
    const afterOwners = rules(NAV_CSS)
      .flatMap((r) => r.selectors)
      .filter((sel) => sel.includes('.navtree-tab-row') && sel.endsWith('::after'));
    // Only the child elbow and the drag drop-edge marker, which never coexist
    // with each other; crucially, nothing keyed on `data-active`.
    expect(afterOwners.some((sel) => sel.includes('data-active'))).toBe(false);
  });

  it('still overhangs by the full fillet radius at both ends', () => {
    // 18px, not 11: a fillet is a square minus a quarter-disc, so only ~21% of
    // its box is ink and a smaller one is a crescent nobody can see.
    const body = ruleBody(NAV_CSS, '.navtree-tab-funnel');
    expect(decl(body, 'top')).toBe('-18px');
    expect(decl(body, 'bottom')).toBe('-18px');
    expect(decl(body, 'width')).toBe('18px');
  });

  it('never eats a click', () => {
    expect(decl(ruleBody(NAV_CSS, '.navtree-tab-funnel'), 'pointer-events')).toBe('none');
  });
});

/**
 * THE SHEET'S WORKSPACE ROW: TWO CONTROLS AT A THUMB'S SIZE.
 *
 * The sheet inherited the desktop's `--nt-ctl: 20px` / `--nt-ctl-gap: 6px`, so
 * its "+" was a 20px target 6px from the × that closes the workspace. The fix
 * overrides the tokens on the sheet's row only — the desktop keeps its numbers —
 * and the target and the glyph are different numbers: 44 for the thumb, 15 for
 * the ink (the glyph size is asserted on the SVG, in NavTree.sheet-controls).
 */
describe('the sheet’s workspace controls clear the touch floor', () => {
  const SHEET_ROW = '.navtree[data-variant="sheet"] .navtree-ws-row';
  const SHEET_CTL = `${SHEET_ROW} > .navtree-tab-controls > .navtree-close`;
  const px = (v: string) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v)?.[1]);

  it('overrides the control size to 44px on the sheet row', () => {
    const row = ruleBody(NAV_CSS, SHEET_ROW);
    expect(px(decl(row, '--nt-ctl'))).toBeGreaterThanOrEqual(44);
    // The row grows with its target, or a 44px button would overhang a 32px row.
    expect(px(decl(row, '--nt-row-ws'))).toBeGreaterThanOrEqual(44);
  });

  it('sizes every sheet control from that token, in both axes, and never hides it', () => {
    const body = ruleBody(NAV_CSS, SHEET_CTL);
    expect(decl(body, 'width')).toBe('var(--nt-ctl)');
    expect(decl(body, 'height')).toBe('var(--nt-ctl)');
    expect(decl(body, 'flex')).toBe('0 0 var(--nt-ctl)');
    expect(decl(body, 'visibility')).toBe('visible');
  });

  it('wears no accent fill and no danger red, even on a sticky touch :hover', () => {
    const hover = ruleBody(NAV_CSS, `${SHEET_CTL}:hover`);
    expect(decl(hover, 'color')).toBe('var(--fg)');
    expect(decl(hover, 'background')).toBe('transparent');
    // …and goes to full strength under the thumb.
    expect(decl(ruleBody(NAV_CSS, `${SHEET_CTL}:active`), 'opacity')).toBe('1');
  });

  it('leaves the DESKTOP tokens exactly where they were', () => {
    const root = rules(NAV_CSS).find(
      (r) => r.atRules.length === 0 && /--nt-ctl:\s*20px/.test(r.body),
    );
    expect(root).toBeTruthy();
    expect(decl(root?.body ?? '', '--nt-ctl-gap')).toBe('6px');
    // The only other place the token is re-declared is the sheet row.
    const owners = rules(NAV_CSS)
      .filter((r) => /(?:^|;)\s*--nt-ctl:/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(owners.filter((sel) => sel !== SHEET_ROW)).toEqual(root?.selectors);
  });

  it('gives the “⋯” menu rows the same 44px floor', () => {
    const item = ruleBody(NAV_CSS, '.navtree-menu.-touch .navtree-menu-item');
    expect(px(decl(item, 'min-height'))).toBeGreaterThanOrEqual(44);
  });
});

/**
 * THE STATUS COLUMN IS A COLUMN, AND THE STRIP MUST NOT BREAK IT.
 *
 * Every mark in the rail lands on one vertical line because nothing in front
 * of it is free to size itself — the hover controls are zero-width at rest
 * for exactly that reason. The working-set strip added a permanent `⌃3` cap
 * in the track BEFORE the mark, so its rows' marks sat ~26px left of the
 * tree's. Reported as "sidebar status icons on right not aligned".
 */
describe('the working-set strip keeps the status column', () => {
  const rule = (selector: string): string => {
    const flat = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = new RegExp(
      `(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
      'm',
    );
    return re.exec(flat)?.[1] ?? '';
  };

  it('carries no slot cap at all, in or out of flow', () => {
    // The cap was first put OUT of flow to stop it taking a track; it is now
    // gone outright, which is the same guarantee by a shorter route. Pinned
    // negatively so a future pass cannot reintroduce it in flow.
    expect(NAV_CSS).not.toMatch(/navtree-slot-key/);
  });

  it('the × is absent at rest, like every other hover control here', () => {
    const drop = rule('.navtree-ws-slot .navtree-slot-drop');
    expect(drop, 'slot drop not found').not.toBe('');
    expect(drop).toMatch(/display:\s*none/);
  });
});

/**
 * THE BAND'S ROWS ARE ON THE SAME TWO COLUMNS AS EVERY OTHER ROW.
 *
 * A chat inside a workspace carries two insets the band had neither of: the
 * scroller's and the group's. So its chips sat 8px left of every chip below
 * them — "the chats there are not horizontally aligned with the rest of the
 * chats below that are in the other sections" — and its status marks sat 4px
 * right of a column this rail keeps to 0.00px.
 */
describe('the at-hand band lines up with the groups', () => {
  const rule = (selector: string): string => {
    const flat = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = new RegExp(
      `(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
      'm',
    );
    return re.exec(flat)?.[1] ?? '';
  };

  it('pays the scroller inset and the group inset, like a row below it does', () => {
    const band = rule('.navtree-workingset');
    // Derived from the tokens, never literals: the two insets are
    // `--nt-pad` each, so left is twice it and right is one.
    expect(band).toMatch(/padding:[^;]*calc\(var\(--nt-pad\) \* 2\)/);
    expect(band).toMatch(/padding:\s*\S+\s+var\(--nt-pad\)/);
  });

  it('pays it as PADDING, so the shelf still runs the full width', () => {
    // Margin would inset the ground too, and a band with side gaps is a card.
    expect(rule('.navtree-workingset')).not.toMatch(/margin:/);
  });

  it('carries no status-coloured mark on its heading', () => {
    // The only coloured marks in this rail are status — a dot for wants-you, a
    // tick for ready, an amber ring for working. A 5px accent square beside a
    // heading reads as one of them: "the red dot looks like an error
    // indicator".
    expect(NAV_CSS).not.toMatch(/\.navtree-workingset-head::before/);
  });
});

/**
 * THE TOP OF THE RAIL IS NOT A STACK OF HAIRLINES.
 *
 * It had five horizontal strokes in about 160px: the brand's, the band's top
 * border, its bottom border, an inset highlight inside its top edge, and a
 * rule trailing the heading. Reported as "top area still messy".
 */
describe('the recently-active band draws one line', () => {
  const body = (selector: string): string => {
    const flat = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = new RegExp(
      `(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
      'm',
    );
    return re.exec(flat)?.[1] ?? '';
  };

  it('keeps the seam where the band STOPS, and nothing on the side above it', () => {
    // The brand's hairline is already there, and it is load-bearing: it lines
    // up with the pane's tab strip.
    const band = body('.navtree-workingset');
    expect(band).toMatch(/border-bottom:/);
    expect(band).not.toMatch(/border-top:/);
    expect(band).not.toMatch(/box-shadow:/);
  });

  it('has a ground instead of a rule after the heading', () => {
    // The rule existed because a short heading over a list read as a stray
    // word. With a ground of its own the label is clearly ON something.
    expect(NAV_CSS).not.toMatch(/\.navtree-workingset-head::after/);
    expect(body('.navtree-workingset')).toMatch(/background:\s*color-mix/);
  });
});
