import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SELECTION, and the one thing it is allowed to be.
 *
 * ─── Why this file exists ────────────────────────────────────────────────
 * The rail's selected row was a SOLID `--accent` block with the label inverted
 * to `--accent-fg`. It was the brightest thing on the screen, it was on screen
 * permanently, and it read as a different KIND of object rather than as the row
 * you are on. The sheet had already been rebuilt as a quiet wash over the rail's
 * own surface with the rail's own ink; the two surfaces were one drawing apart.
 *
 * The solid block was not arbitrary — it was forced. NavTree.css argued that a
 * tint "is no longer available to it", because every non-idle row carried a
 * faint tint of its state hue (StateChip.css) and "where I am" and "what the
 * machine is doing" cannot share an encoding. That was TRUE when it was written
 * and is not true now: the chat row stopped emitting `data-state` when the row
 * tint and the 3px state bar were deleted (see RowMark in NavTree.tsx), so the
 * tint channel has been free ever since and nothing noticed. This file pins the
 * consequence so it cannot silently invert again.
 *
 * ─── What it asserts, and why each one is a defect that shipped ───────────
 * Three of these are cascade invariants, and three are ARITHMETIC over the real
 * theme tokens — because the interesting failures here are not missing rules,
 * they are rules that are present and wrong in one theme out of six:
 *
 *   · `--accent-fg` on a 20% accent wash measures 1.04:1 (dracula) to 1.81:1
 *     (alucard). Every inverted-ink rule is not merely redundant under a wash,
 *     it is illegible, so "no --accent-fg under [data-active]" is a hard rule
 *     rather than a tidiness preference.
 *   · a 20% accent wash measures 1.33 against the tokyo-night rail and 1.39
 *     against dracula's — while `--bg-hover`, a theme token tuned for panels,
 *     measures 1.50 and 2.09 against those same two rails. So the naive fix
 *     makes HOVERING AN UNSELECTED ROW louder than the selected row on the two
 *     darkest themes. This is the defect the wash introduces, it is invisible
 *     to inspection, and `selection out-ranks hover` below is the assertion
 *     that catches it.
 *
 * jsdom has no layout engine and no `color-mix`, so the arithmetic here is a
 * MODEL: srgb mixing and WCAG relative luminance, computed from the same token
 * values the browser reads out of styles.css. `color-mix(… X%, transparent)`
 * over an opaque ground is exactly an alpha-X composite, which is why the model
 * and the engine agree. If they ever disagree, the engine is right.
 */

const read = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const NAV_CSS = read('NavTree.css');
const APP_CSS = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8');

const flat = (s: string) => s.replace(/\s+/g, ' ');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every top-level `{ selectors, body }` in a sheet. Brace-counted, so an
 *  at-rule's own block is never mistaken for the rule nested inside it. */
function rules(sheet: string): { selectors: string[]; body: string; inAt: boolean }[] {
  const clean = strip(sheet);
  const out: { selectors: string[]; body: string; inAt: boolean }[] = [];
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
    const close = clean.indexOf('}', re.lastIndex);
    out.push({
      selectors: head.split(',').map((s) => flat(s).trim()),
      body: flat(clean.slice(re.lastIndex, close === -1 ? undefined : close)),
      inAt: stack.length > 0,
    });
    stack.push(head);
  }
  return out;
}

function ruleBody(sheet: string, selector: string): string {
  const hits = rules(sheet).filter((r) => r.selectors.includes(selector));
  if (hits.length === 0) throw new Error(`no rule for selector: ${selector}`);
  return hits.map((r) => r.body).join(' ');
}

function decl(body: string, prop: string): string {
  const all = [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))];
  if (all.length === 0) throw new Error(`no declaration: ${prop}`);
  return ((all[all.length - 1] as RegExpMatchArray)[1] ?? '').trim();
}

/**
 * A rule's winning row FILL, whichever way it spells the property. The nav rows
 * are not uniform here and deliberately so — `background-color` is mandatory
 * wherever a row can also carry StateChip's background-IMAGE (the shorthand
 * would silently reset it), and the plain `background` survives on rows that
 * cannot. A ranking test must read both or it reads whichever it was written
 * against.
 */
function fill(body: string): string {
  for (const prop of ['background-color', 'background']) {
    try {
      return decl(body, prop);
    } catch {
      /* try the other spelling */
    }
  }
  throw new Error(`no background declaration: ${body}`);
}

const RAIL_ACTIVE = '.navtree-tab-row[data-active="true"]';
const SHEET_ACTIVE = '.navtree[data-variant="sheet"] .navtree-tab-row[data-active="true"]';

/* ─── The colour model ──────────────────────────────────────────────────── */

type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const s = h.trim();
  if (!/^#[0-9a-f]{6}$/i.test(s)) throw new Error(`not a hex colour: ${h}`);
  return [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as Rgb;
};
const lin = (c: number) => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const lum = (h: string) => {
  const [r, g, b] = hex(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
/** WCAG contrast ratio. */
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `color-mix(in srgb, top P%, transparent)` composited over `ground`. */
const over = (top: string, ground: string, p: number) => {
  const [A, B] = [hex(top), hex(ground)];
  return `#${A.map((v, i) =>
    Math.round(v * p + (B[i] as number) * (1 - p))
      .toString(16)
      .padStart(2, '0'),
  ).join('')}`;
};

/**
 * The six themes, read out of styles.css rather than restated here — a theme
 * whose accent moves must move these numbers too, or the test is decoration.
 */
function themes(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const r of rules(APP_CSS)) {
    for (const sel of r.selectors) {
      const m = /^\[data-theme="([\w-]+)"\]$/.exec(sel);
      if (!m) continue;
      const t: Record<string, string> = {};
      for (const d of r.body.matchAll(/(--[\w-]+):\s*([^;]+)/g))
        t[d[1] as string] = (d[2] as string).trim();
      out[m[1] as string] = t;
    }
  }
  return out;
}
const THEMES = themes();

/**
 * The `--nt-*` surface tokens, read off `.navtree` — so a rule that says
 * `var(--nt-sel)` is measured as the mix it actually resolves to. Reading them
 * rather than restating them is the point: the CSS keeps one authority for the
 * number and this file computes from it, which is the discipline
 * NavTree.spacing.test.ts established for the row's geometry.
 */
const NT_TOKENS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const m of ruleBody(NAV_CSS, '.navtree').matchAll(/(--nt-[\w-]+):\s*([^;]+)/g))
    out[m[1] as string] = (m[2] as string).trim();
  return out;
})();
const deNt = (expr: string) =>
  flat(expr).replace(/var\((--nt-[\w-]+)\)/g, (_, n: string) => {
    const v = NT_TOKENS[n];
    if (v === undefined) throw new Error(`unknown nav token: ${n}`);
    return v;
  });

/** `color-mix(in srgb, var(--tok) N%, transparent)` → [token, fraction]. */
function washOf(expr: string): [token: string, p: number] {
  const m = /color-mix\(\s*in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%\s*,\s*transparent\s*\)/.exec(
    deNt(expr),
  );
  if (!m) throw new Error(`not a wash over transparent: ${expr} (→ ${deNt(expr)})`);
  return [m[1] as string, Number(m[2]) / 100];
}
/** The accent fraction, insisting the wash is of the ACCENT and nothing else. */
function washPercent(expr: string): number {
  const [token, p] = washOf(expr);
  if (token !== '--accent') throw new Error(`wash is of ${token}, not --accent: ${expr}`);
  return p;
}
/** A row surface's contrast against the rail, whatever form it is written in. */
function vsRail(expr: string, t: Record<string, string>): number {
  const rail = t['--bg-tabbar'] as string;
  try {
    const [token, p] = washOf(expr);
    return ratio(over(t[token] as string, rail, p), rail);
  } catch {
    const flat1 = deNt(expr)
      .replace(/var\(|\)/g, '')
      .trim();
    return ratio(t[flat1] as string, rail);
  }
}

describe('the themes this file measures against', () => {
  it('finds all six, each with the tokens the arithmetic needs', () => {
    // Guards the guard: a parser that silently found nothing would make every
    // `for (const theme of …)` below vacuously pass.
    expect(Object.keys(THEMES).sort()).toEqual([
      'acme',
      'acme-dark',
      'alucard',
      'dracula',
      'github-light',
      'tokyo-night',
    ]);
    for (const [name, t] of Object.entries(THEMES))
      for (const token of ['--bg-tabbar', '--bg-hover', '--fg', '--accent'])
        expect({ name, token, has: typeof t[token] }).toEqual({ name, token, has: 'string' });
  });
});

describe('selection is a TINT of the accent, never a fill of it', () => {
  it('the rail’s selected row washes the accent over its own surface', () => {
    const bg = decl(ruleBody(NAV_CSS, RAIL_ACTIVE), 'background-color');
    // The shipped defect, named: a bare `var(--accent)` is a solid block.
    expect(bg).not.toBe('var(--accent)');
    expect(washPercent(bg)).toBeGreaterThan(0);
    expect(washPercent(bg)).toBeLessThanOrEqual(0.3);
  });

  it('BOTH surfaces select with the same value — one grammar, one number', () => {
    // The two had drifted apart: the sheet was rebuilt as a wash and the rail
    // was left as a slab, so "where I am" was drawn two different ways in one
    // component. Asserting the EXPRESSIONS match is what stops a future tweak
    // to one surface from quietly re-forking them.
    expect(decl(ruleBody(NAV_CSS, SHEET_ACTIVE), 'background-color')).toBe(
      decl(ruleBody(NAV_CSS, RAIL_ACTIVE), 'background-color'),
    );
  });

  it('never inverts the row’s ink: no --accent-fg on a selected CHAT row', () => {
    // Not a tidiness rule. `--accent-fg` over a 20% accent wash measures 1.04:1
    // on dracula and 1.81:1 on alucard — the inverted-ink rules are not merely
    // redundant under a wash, they are illegible, and there were thirty
    // declarations of them. Scanned across @media blocks too: the
    // reduced-motion mark had an arm of its own.
    //
    // MATCHED IN TWO PARTS, not as one literal string, and that is the whole
    // reliability of this test. Written as `.navtree-tab-row[data-active="true"]`
    // it missed
    //   .navtree[data-variant="sheet"] .navtree-tab-row[data-child="true"][data-active="true"]
    // because a second attribute selector sits between the two halves — and a
    // real offender was hiding in exactly that gap: the sheet's selected CHILD
    // name, --accent-fg over the wash the sheet has shipped all along. Any
    // qualifier may intervene now.
    const offenders = rules(NAV_CSS)
      .filter((r) =>
        r.selectors.some(
          (s) =>
            (/\.navtree-tab-row/.test(s) || /\.navtree-foot-link/.test(s)) &&
            /\[data-active="true"\]/.test(s),
        ),
      )
      .filter((r) => /--accent-fg/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(offenders).toEqual([]);
  });

  it('the PANE row deliberately keeps its slab, because it still has a state tint', () => {
    // The exception, pinned so it reads as a decision rather than a row that was
    // missed. The chat row could take the tint channel only because it STOPPED
    // emitting `data-state` when the row tint and the 3px bar were deleted. A
    // pane row never did (NavTree.tsx still writes it), so it still carries a
    // faint tint of its status hue — and "where I am" and "what the machine is
    // doing" genuinely cannot share the tint channel on that surface. Its
    // inverted × hover is therefore still correct, and is split out of the chat
    // row's rule rather than sharing it.
    expect(
      decl(ruleBody(NAV_CSS, '.navtree-pane-row-wrap[data-active="true"]'), 'background-color'),
    ).toBe('var(--accent)');
    expect(
      decl(
        ruleBody(NAV_CSS, '.navtree-pane-row-wrap[data-active="true"] .navtree-close:hover'),
        'background-color',
      ),
    ).toBe('var(--accent-fg)');
  });

  it('Hosted moved with the rows — one selection grammar for the whole navigator', () => {
    // A solid accent Hosted row under a rail of quiet ones would leave the
    // loudest thing on the rail on the one destination you are least often in.
    expect(
      decl(ruleBody(NAV_CSS, '.navtree-foot-link[data-active="true"]'), 'background-color'),
    ).toBe('var(--nt-sel)');
  });
});

describe('what the quiet selection HANDS BACK to the row', () => {
  it('the A2 chip draws itself — nothing re-inks it on the selected row', () => {
    // The slab silently deleted the clock on exactly the row you were looking
    // at: `--clock` is `accent 34%` mixed toward a base, and on an --accent
    // fill that is very nearly invisible, so the dot had to be forced to
    // --accent-fg and the tile's fill dropped outright. Over a wash the chip's
    // own material reads as it does on any other row. The chip is A2's: this
    // asserts the rail DRAWS it and does not reach into it.
    const offenders = rules(NAV_CSS)
      .filter((r) => r.selectors.some((s) => s.includes('[data-active="true"]')))
      .filter((r) => r.selectors.some((s) => /\.chatchip/.test(s)))
      .flatMap((r) => r.selectors);
    expect(offenders).toEqual([]);
  });

  it('the state mark keeps its own hue on the selected row', () => {
    // Four states told apart by colour were flattened to one ink on the
    // selected row, so the row you were on was the one row whose state you
    // could not read. The status hues are tuned against the rail's surface,
    // which is what a wash leaves underneath them.
    const offenders = rules(NAV_CSS)
      .filter((r) => r.selectors.some((s) => s.includes('[data-active="true"]')))
      .filter((r) => r.selectors.some((s) => /\.navtree-mark/.test(s)))
      .flatMap((r) => r.selectors);
    expect(offenders).toEqual([]);
  });

  it('the name is the rail’s own ink, and selection is told by WEIGHT', () => {
    // Weight is the one step that costs no contrast. 640 sits clearly under the
    // unread 700, which is the distinction the sheet already ships — so "you
    // are here" and "unread" stay separable without a second colour.
    const body = ruleBody(NAV_CSS, `${RAIL_ACTIVE} .navtree-name-text`);
    expect(decl(body, 'color')).toBe('var(--fg)');
    expect(decl(body, 'font-weight')).toBe('640');
    const unread = ruleBody(NAV_CSS, `.navtree-tab-row[data-unread="true"] .navtree-name-text`);
    expect(Number(decl(unread, 'font-weight'))).toBeGreaterThan(640);
  });

  it('…and on a row that is BOTH, unread still wins — on BOTH surfaces', () => {
    // The assertion above compares the two NUMBERS and is satisfied by 700 >
    // 640. That is not the invariant. The invariant is which one a row that is
    // selected AND unread actually gets, and the numbers cannot see it: the
    // sheet's unread rule and its active rule are both (0,5,0), so the winner
    // was decided by SOURCE ORDER — and the active rule is declared second, so
    // 640 won and the unread signal vanished from exactly the chat you had
    // open. Measured in a real browser before the fix: rail 700, sheet 640.
    //
    // The rail is asserted too, though it already passed. It passes by
    // accident — its unread rule merely happens to sit lower in the file — and
    // an accident is worth a test precisely because moving a rule would end it.
    //
    // jsdom has no layout but it does have a cascade, which is the whole
    // subject (the technique, and its one blind spot, are documented in
    // SwipeRow.cascade.test.ts — both rules here are standalone, so the
    // max-of-the-selector-list scoring it warns about cannot bite).
    for (const variant of ['sidebar', 'sheet'] as const) {
      document.head.innerHTML = `<style>${NAV_CSS}</style>`;
      document.body.innerHTML = `
        <div class="navtree" data-variant="${variant}">
          <div class="navtree-tab-row" data-active="true" data-unread="true">
            <span id="name" class="navtree-name-text">Reading List</span>
          </div>
        </div>`;
      const weight = getComputedStyle(document.getElementById('name') as HTMLElement).fontWeight;
      expect({ variant, weight }).toEqual({ variant, weight: '700' });
    }
  });
});

describe('the ARITHMETIC — six themes, and the defect the wash introduces', () => {
  const wash = () => washPercent(decl(ruleBody(NAV_CSS, RAIL_ACTIVE), 'background-color'));

  it('the name on the wash clears AA on every theme', () => {
    for (const [name, t] of Object.entries(THEMES)) {
      const ground = over(t['--accent'] as string, t['--bg-tabbar'] as string, wash());
      const cr = ratio(t['--fg'] as string, ground);
      expect({ name, ok: cr >= 4.5, cr: Number(cr.toFixed(2)) }).toEqual({
        name,
        ok: true,
        cr: Number(cr.toFixed(2)),
      });
    }
  });

  it('SELECTION OUT-RANKS HOVER on every theme — the one the naive fix fails', () => {
    // THE point of this file. A 20% wash is 1.33 on the tokyo-night rail and
    // 1.39 on dracula's; `--bg-hover` is 1.50 and 2.09 on the same two. Quieting
    // selection without also deriving the row's hover makes a hovered
    // UNSELECTED row louder than the selected one, on the two darkest themes,
    // and nothing else in the suite can see it.
    // BOTH rows that take --nt-sel are ranked, not just the chat row. Hosted was
    // converted to the wash and its hover was left on --bg-hover, so the rung
    // scale held on one row and not the other and this test could not see it —
    // 2.09:1 on the dracula rail under a selected row's 1.39. A row is only
    // converted when its hover comes with it.
    const pairs: [row: string, hover: string, selected: string][] = [
      ['chat row', '.navtree-tab-row:hover', RAIL_ACTIVE],
      ['Hosted', '.navtree-foot-link:hover', '.navtree-foot-link[data-active="true"]'],
    ];
    for (const [row, hoverSel, activeSel] of pairs) {
      const hover = fill(ruleBody(NAV_CSS, hoverSel));
      const selected = fill(ruleBody(NAV_CSS, activeSel));
      for (const [name, t] of Object.entries(THEMES)) {
        const sel = vsRail(selected, t);
        const hov = vsRail(hover, t);
        expect({ row, name, ok: sel > hov, sel: +sel.toFixed(2), hov: +hov.toFixed(2) }).toEqual({
          row,
          name,
          ok: true,
          sel: +sel.toFixed(2),
          hov: +hov.toFixed(2),
        });
      }
    }
  });

  it('…and the theme token it replaced would have FAILED that, on two themes', () => {
    // Guards the guard, and records the measurement. Swapping --bg-hover back in
    // is the obvious "simplification" of the rung scale, so this pins what it
    // would cost: dracula 2.09 and tokyo-night 1.50 against a wash of 1.39 and
    // 1.33. If this test ever stops finding failures, the token has changed and
    // the derived hover may genuinely no longer be needed — which is a result
    // worth being told about, not a test to delete.
    const selected = decl(ruleBody(NAV_CSS, RAIL_ACTIVE), 'background-color');
    const failed = Object.entries(THEMES)
      .filter(([, t]) => vsRail(selected, t) <= vsRail('var(--bg-hover)', t))
      .map(([name]) => name);
    expect(failed.sort()).toEqual(['acme-dark', 'dracula', 'tokyo-night']);
  });

  it('…and hovering the row you are ALREADY on is still visible', () => {
    // It must be a step of the block's own fill, not a second colour — the row
    // you are on has almost nothing to say on hover, so it says it quietly.
    const hov = washPercent(decl(ruleBody(NAV_CSS, `${RAIL_ACTIVE}:hover`), 'background-color'));
    expect(hov).toBeGreaterThan(wash());
  });
});

describe('item 2 — the seams are WHITESPACE, not hairlines', () => {
  it('nothing rules off one workspace group from the next', () => {
    // Measured reason, not taste: `--border` against `--bg-tabbar` is 1.00:1 on
    // alucard (#ddd8ee on #ddd8ef), 1.06 on acme and 1.14 on github-light. The
    // hairline is already invisible on half the themes, so it is not a signal
    // being traded for whitespace — it is noise on the themes where it DOES
    // show and nothing on the ones where it doesn't.
    const body = ruleBody(NAV_CSS, '.navtree-group + .navtree-group');
    expect(body).not.toMatch(/border-top:\s*1px/);
    // The gap has to survive the rule's deletion, or the groups merge.
    expect(Number.parseFloat(decl(body, 'margin-top'))).toBeGreaterThanOrEqual(14);
  });

  it('the pin seam IS a line, and one that can actually be seen', () => {
    // Reversed deliberately. The old rule was "paints nothing at all", on the
    // reasoning that pinning is already told by POSITION and per-row by "the
    // pin button's aria-pressed" — and aria-pressed is not a visual signal, so
    // that half was never on screen: `.navtree-pin` is a `.navtree-close`, and
    // those have zero width until the row is hovered. The whole indicator was a
    // gap. Reported as "no indicator no line just a bit of spacing. not good".
    const body = ruleBody(NAV_CSS, '.navtree-pin-divider');
    expect(body).toMatch(/border-top:\s*1px/);
    // And NOT in `--border`, which the sibling test above measures at 1.00:1
    // against the rail on alucard — a hairline nobody can see is the state this
    // is fixing, not a fix for it. Derived from the foreground instead, which
    // has to be readable on every theme by construction.
    expect(decl(body, 'border-top')).toMatch(/--fg/);
    expect(decl(body, 'border-top')).not.toMatch(/var\(--border\)/);
  });
});
