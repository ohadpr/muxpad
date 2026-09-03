import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The nav row's HORIZONTAL spacing scale, pinned.
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

  it('every row kind insets its tail by one step of AIR, in both variants', () => {
    for (const [name, t] of VARIANTS) {
      const air = resolve(t['--nt-air'] as string, t);
      for (const kind of KINDS) {
        expect({ name, kind, gap: paddingRight(kind, t) }).toEqual({ name, kind, gap: air });
        expect(paddingRight(kind, t)).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('the sheet’s tab row does not quietly re-declare its own right inset', () => {
    // It overrides top/bottom/left (different row metrics) and MUST inherit the
    // right, or the two variants drift apart the next time one of them moves.
    const body = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-row');
    expect(body).not.toMatch(/(?:^|;)\s*padding-right:/);
    expect(body).not.toMatch(/(?:^|;)\s*padding:/);
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
    for (const [name, t] of VARIANTS) {
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
      for (const [name, t] of VARIANTS) {
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
    // The sheet spends its indent on the leading disclosure track instead, so
    // its row padding-left is the bare pad.
    const sheetRow = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-row');
    expect(resolve(decl(sheetRow, 'padding-left'), SHEET)).toBe(4);
  });

  it('the pane list keeps its 18px hierarchy step under the tab name', () => {
    // Derived, because as a literal (64px) it silently shrank to a 6px step the
    // moment the icon track grew — children reading as siblings.
    // Evaluated against the SHEET only, and that is correct rather than lazy:
    // the pane list is sheet-gated in NavTree.tsx (the expander only renders at
    // `variant === 'sheet'`), and the derivation encodes the sheet's row shape
    // — a leading --nt-disc track, with the indent spent there instead of in
    // the row's padding. On the rail the same expression would give 24px, not
    // 18. If a pane list is ever rendered on the rail, this is the rule to
    // revisit first.
    const listLeft = side(decl(ruleBody(NAV_CSS, '.navtree-pane-list'), 'padding'), 'left');
    const paneRowPad = side(decl(ruleBody(NAV_CSS, '.navtree-pane-row'), 'padding'), 'left');
    // Where a tab NAME starts, measured from the list's own left edge.
    const tabNameLeft =
      resolve('var(--nt-pad)', SHEET) +
      resolve(SHEET['--nt-disc'] as string, SHEET) +
      resolve(SHEET['--nt-col-icon'] as string, SHEET);
    const paneLabelLeft = resolve(listLeft, SHEET) + resolve(paneRowPad, SHEET);
    expect(paneLabelLeft - tabNameLeft).toBe(18);
  });

  it('the pass is HORIZONTAL only — no vertical metric moved', () => {
    // Row heights are 34/50 on the rail and 44/61 on the sheet, and they come
    // from the vertical padding plus the text lines. Air must never appear in
    // one, or a one-line row stops matching --nt-row-tab and the leading of
    // one- and two-line rows diverges again.
    const railPad = decl(ruleBody(NAV_CSS, '.navtree-tab-row'), 'padding');
    expect(resolve(side(railPad, 'top'), BASE)).toBe(8);
    expect(resolve(side(railPad, 'bottom'), BASE)).toBe(8);
    const sheetRow = ruleBody(NAV_CSS, '.navtree[data-variant="sheet"] .navtree-tab-row');
    expect(resolve(decl(sheetRow, 'padding-top'), SHEET)).toBe(12);
    expect(resolve(decl(sheetRow, 'padding-bottom'), SHEET)).toBe(12);
    // 12 + 20 (--nt-icon-h) + 12 = 44, exactly the touch floor.
    expect(12 + resolve(SHEET['--nt-icon-h'] as string, SHEET) + 12).toBe(44);
    // 8 + 18 + 8 = 34, exactly --nt-row-tab.
    expect(8 + resolve(BASE['--nt-icon-h'] as string, BASE) + 8).toBe(
      resolve(BASE['--nt-row-tab'] as string, BASE),
    );
  });
});
