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

function ruleBody(sheet: string, selector: string, allowMissing = false): string {
  const hits = rules(sheet).filter((r) => r.selectors.includes(selector));
  if (hits.length === 0 && !allowMissing) throw new Error(`no rule for selector: ${selector}`);
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
/**
 * Perceptual distance in OKLab (×100) — "do these two surfaces look different?"
 *
 * NOT the WCAG ratio above, and the distinction is load-bearing here. A contrast
 * ratio is a LEGIBILITY metric: it answers "can text on this be read", it is
 * built from luminance alone, and it is blind to hue. For two near-identical
 * BACKGROUNDS that is the wrong question and gives the wrong answer — acme's
 * rail is lilac #f0e9f6 and its content is cream #fdf6ea, which a luminance
 * ratio calls nearly identical and an eye does not.
 *
 * Keep `ratio` for text on a ground. Use this for surface against surface.
 */
const oklab = (h: string): [number, number, number] => {
  const [r = 0, g = 0, b = 0] = hex(h).map((v) => lin(v));
  const l = Math.cbrt(0.4122 * r + 0.5363 * g + 0.0514 * b);
  const m = Math.cbrt(0.2119 * r + 0.6807 * g + 0.1074 * b);
  const q = Math.cbrt(0.0883 * r + 0.2817 * g + 0.63 * b);
  return [
    0.2105 * l + 0.7936 * m - 0.0041 * q,
    1.978 * l - 2.4286 * m + 0.4506 * q,
    0.0259 * l + 0.7828 * m - 0.8087 * q,
  ];
};
const deltaE = (a: string, b: string) => {
  const [A, B] = [oklab(a), oklab(b)];
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) * 100;
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
/**
 * `--bg-pane-face` resolved per theme.
 *
 * It lives in `:root` as a mix of two theme tokens — the active pane's 5%
 * accent wash — so it is not in any `[data-theme]` block and the map above
 * cannot see it. The PERCENTAGE is read out of styles.css rather than restated
 * here: it is the one number the pane, the desktop tab strip and the sidebar's
 * selected row all have to agree on, and a copy of it in the test would be a
 * fourth place for it to drift.
 */
const PANE_FACE_PCT = (() => {
  const m = /--bg-pane-face:\s*color-mix\(in srgb, var\(--accent\) ([\d.]+)%, var\(--bg\)\)/.exec(
    APP_CSS,
  );
  if (!m) throw new Error('--bg-pane-face is not the expected accent-over-bg mix');
  return Number(m[1]) / 100;
})();
const paneFace = (t: Record<string, string>) =>
  over(t['--accent'] as string, t['--bg'] as string, PANE_FACE_PCT);

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
/** The same resolution as `vsRail`, measured perceptually. See `deltaE`. */
function dEvsRail(expr: string, t: Record<string, string>): number {
  const rail = t['--bg-tabbar'] as string;
  if (expr.includes('--bg-pane-face')) return deltaE(paneFace(t), rail);
  try {
    const [token, p] = washOf(expr);
    return deltaE(over(t[token] as string, rail, p), rail);
  } catch {
    const flat = deNt(expr)
      .replace(/var\(|\)/g, '')
      .trim();
    return deltaE(t[flat] as string, rail);
  }
}

function vsRail(expr: string, t: Record<string, string>): number {
  const rail = t['--bg-tabbar'] as string;
  if (expr.includes('--bg-pane-face')) return ratio(paneFace(t), rail);
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

describe('selection is the CONTENT SURFACE, not a colour on the list', () => {
  it('the selected row takes the PANE FACE, so it and the pane are one shape', () => {
    // This was a 20% accent wash. It is now the content surface itself: the row
    // runs into the pane with no right-hand radius and no gap, which is what
    // makes it read as a tab the panel hangs from rather than a highlight.
    //
    // THE TOKEN, NEVER A LITERAL. The content surface is #f5f4fb on alucard,
    // #fdf6ea on acme, #1a1b26 on tokyo-night, #221547 on acme-dark — only
    // github-light is actually white, so a hardcoded colour would be correct on
    // one theme in six. Reading the token also means the row and the pane cannot
    // drift, because they resolve the same value.
    // `--bg-pane-face`, NOT `--bg`. The visible pane wears a 5% accent wash
    // saying "this is the one you are in", so against plain --bg the tab was a
    // measurably different shade — 245,244,251 against 238,235,249, sampled
    // across the seam — which is what "the tab does not reach the content"
    // actually was. One token, three readers: this row, the desktop tab strip,
    // and the wash itself.
    const body = ruleBody(NAV_CSS, RAIL_ACTIVE);
    expect(decl(body, 'background-color')).toBe('var(--bg-pane-face)');
    expect(decl(body, 'border-radius')).toMatch(/0 0/);
  });

  it('frees the accent entirely — selection spends none of it', () => {
    // The point of the change, and the thing most likely to be undone by
    // somebody "restoring" the highlight. With selection on the content surface
    // the accent is left to mean one thing only: a row that wants you.
    const body = ruleBody(NAV_CSS, RAIL_ACTIVE);
    expect(body).not.toMatch(/--accent/);
  });

  it('the SHEET keeps the accent wash, because it has no pane to join', () => {
    // These were deliberately identical for a long time — the sheet had been
    // rebuilt as a wash while the rail was still a slab, so "where I am" was
    // drawn two ways in one component, and pinning them equal stopped that
    // recurring.
    //
    // They now differ, and the reason is structural rather than cosmetic. The
    // rail sits BESIDE its content, so its selected row can BE the edge of that
    // content. The sheet floats OVER the content as a dropdown — there is no
    // pane beside it to join, and a row painted `--bg` there would be a pale
    // band meaning nothing.
    //
    // Pinned as a divergence rather than deleted, so the next reader finds a
    // decision instead of an inconsistency.
    expect(decl(ruleBody(NAV_CSS, RAIL_ACTIVE), 'background-color')).toBe('var(--bg-pane-face)');
    expect(decl(ruleBody(NAV_CSS, SHEET_ACTIVE), 'background-color')).toBe('var(--nt-sel)');
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
    //
    // NARROWED, deliberately. This began as "no rule mentioning both
    // `[data-active]` and `.chatchip`", which is a proxy for the real rule and
    // outlawed a legitimate one: draining the chips of INACTIVE workspaces
    // (grayscale + opacity, applied to the whole chip, and lifted again on the
    // row you are on). That is not re-inking — it does not pick a colour inside
    // the chip and overrule it, it attenuates the chip's own material
    // uniformly and reversibly. What broke the clock was `color`, a `fill`, and
    // a dropped background; those are what this forbids now, by name.
    const INK = /(^|[\s;{])(color|background|background-color|fill|stroke|--clock)\s*:/;
    const offenders = rules(NAV_CSS)
      .filter((r) => r.selectors.some((s) => s.includes('[data-active="true"]')))
      .filter((r) => r.selectors.some((s) => /\.chatchip/.test(s)))
      .filter((r) => INK.test(r.body))
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

describe('the ARITHMETIC — six themes, and the defect the TAB introduces', () => {
  it('the name on the tab clears AA on every theme — trivially, and that is the point', () => {
    // The selected row is the CONTENT surface, so its text sits on exactly the
    // pairing the whole app reads on. It cannot be less legible than the chat
    // beside it without the chat being illegible too. Measured anyway, because
    // "obviously fine" is how the wash got shipped at 1.04:1 on dracula.
    for (const [name, t] of Object.entries(THEMES)) {
      const cr = ratio(t['--fg'] as string, t['--bg'] as string);
      expect({ name, ok: cr >= 4.5 }).toEqual({ name, ok: true });
    }
  });

  it('SELECTION OUT-RANKS HOVER on every theme — by SHAPE, which hover has no access to', () => {
    // THE point of this file, and it has now caught three designs.
    //
    // While selection was an accent wash it was far from any rail and the fill
    // alone always won. The tab is the PANE's face, which on a theme whose rail
    // and pane sit close together barely separates from the rail at all:
    //
    //   acme — lilac rail #f0e9f6, cream pane #fdf6ea + a 5% violet wash
    //   tab vs rail        ΔE 2.40
    //   hover at 4%        ΔE 2.70   ← an idle row beats the row you are on
    //   hover at 6%        ΔE 4.05
    //
    // THE EDGE THAT USED TO ANSWER THIS IS GONE, and the arithmetic above is
    // why it was tried: three inset hairlines, a channel hover does not have.
    // It could not hold the geometry. The hairlines follow the ROW's rectangle
    // while the fillets extend the surface 18px past it, so the top edge ran
    // straight through the point where the tab had already curved away and
    // ended in mid-air over the corner. Reported as "the lines here are no
    // good".
    //
    // The premise was wrong too, which is the part worth keeping. A ΔE
    // comparison between selection and hover assumes they compete for one
    // glance, and they do not: hover is transient and sits under the cursor,
    // where the reader already knows their pointer is, while selection has to
    // be readable AT REST — and at rest nothing is hovered. What selection has
    // that hover cannot have at any fill value is the SHAPE: the row merges
    // into the pane. A tint cannot round a corner into the content.
    //
    // So the invariant is unchanged — "distinguished in a way hover never is" —
    // and what carries it is the funnel.
    const selected = ruleBody(NAV_CSS, RAIL_ACTIVE);
    const hovered = ruleBody(NAV_CSS, '.navtree-tab-row:hover');
    const fillet = ruleBody(NAV_CSS, `${RAIL_ACTIVE}::after`);

    // The shape, stated as the three things that make it one: it takes the
    // pane's own face, it loses its right-hand corners, and it reaches past the
    // rail's padding so there is no strip of rail left between the two.
    expect(decl(selected, 'background-color')).toBe('var(--bg-pane-face)');
    expect(decl(selected, 'border-radius')).toMatch(/^var\(--nt-pill\) 0 0 var\(--nt-pill\)$/);
    expect(decl(selected, 'margin-right')).toContain('-1');
    expect(decl(fillet, 'background-image')).toContain('--bg-pane-face');

    // And hover has none of it — no fill from the pane, no geometry at all. A
    // hovered row cannot be mistaken for the selected one however the two fills
    // measure on a given theme, which is what the edge was standing in for.
    expect(fill(hovered)).not.toContain('--bg-pane-face');
    expect(hovered).not.toMatch(/border-radius|margin-right|box-shadow/);
    // No edge on the selected row either — a straight line cannot follow this
    // shape, and one that tries ends over the curve.
    expect(selected).not.toMatch(/box-shadow/);

    // The fill arithmetic is still RECORDED, because it is the reason the shape
    // has to carry this and a palette change that fixes acme should show up
    // here as a change rather than silently.
    const fillAloneFails = Object.entries(THEMES)
      .filter(([, t]) => dEvsRail('var(--bg-pane-face)', t) <= dEvsRail(fill(hovered), t))
      .map(([name]) => name);
    expect(fillAloneFails).toEqual(['acme']);
  });

  it('the tab does NOT move on hover, and that is deliberate', () => {
    // Inverted from what this asserted under the wash. The selected row is not a
    // control you are considering — it is where you already are, and it is
    // joined to the pane. Tinting it on hover would break the join for no
    // information: every other row answers "could I go here", and this one
    // cannot.
    const hoverBg = decl(ruleBody(NAV_CSS, `${RAIL_ACTIVE}:hover`), 'background-color');
    const restBg = decl(ruleBody(NAV_CSS, RAIL_ACTIVE), 'background-color');
    expect(hoverBg).toBe(restBg);
  });
});

describe('item 2 — the seams are WHITESPACE, not hairlines', () => {
  it('marks the ACTIVE workspace with an edge, never a second fill', () => {
    // The active header used to be `accent 16%` over the same surface, and the
    // active ROW is the accent at 20% alpha. Measured on the light theme the two
    // came out at a contrast ratio of 1.00 — identical luminance. Two different
    // meanings ("the group you are in", "the row you are reading") wearing one
    // colour, so the header read as a second selection.
    // The accent stays, because a bold name alone cannot say which workspace you
    // are in; it is spent in a different SHAPE. Every header wears the same
    // neutral band, and the active one takes an edge.
    //
    // WHERE that edge lives has moved twice, and the current answer is the one
    // worth pinning. It was an inset shadow on the HEADER (which inherited the
    // band's radius and read as a notch), then the group's border-left. Both
    // were strokes trying to do a CONTAINER's job, and both lost — reported as
    // "they all converge too much", because a stroke is texture and a workspace
    // needed to be an object. The group is a card now, and the active one takes
    // a RING around that card.
    // THE CARD IS GONE, and with it the question it kept failing to answer.
    // "How does a workspace say you are here" was answered four times — an inset
    // shadow, a border, a full ring, then elevation — and every answer was at
    // the wrong level. A card groups the rows you can SEE beside it; once a
    // workspace runs eleven rows its own container has scrolled off with them,
    // which is why five independent redesigns all deleted it first.
    //
    // AND THE CARD CAME BACK, which does not undo any of the above — read what
    // it was deleted FOR. The complaint was never "a workspace needs no body",
    // it was that four different attempts spent the ACCENT on saying which
    // workspace you are in, at a level where it could not survive a scroll. The
    // tray is a neutral body with no accent in it at all; "where you are" is
    // still the sticky band's job and still the one device a scroll cannot take
    // away. What the tray adds is the END of a group, which a band cannot say.
    //
    // So the assertion is unchanged in substance: no accent, no stroke, nothing
    // trying to mark the active workspace at the container level.
    const group = ruleBody(NAV_CSS, '.navtree-group');
    expect(group).not.toMatch(/--accent/);
    expect(group).not.toMatch(/box-shadow/);
    expect(group).not.toMatch(/border-left/);
    expect(ruleBody(NAV_CSS, '.navtree-group[data-active="true"]', true)).toBe('');

    // The active header's ONLY mark is its label stepping to full ink. No
    // fill, no edge, no accent — the accent means "needs you", and the active
    // TAB inside the group is already the one tinted surface on screen.
    const active = ruleBody(NAV_CSS, '.navtree-ws-row[data-active="true"] .navtree-name-text');
    expect(decl(active, 'color')).toBe('var(--fg)');
    expect(active).not.toMatch(/background|box-shadow|border/);
    // …and the group-scoped hover band that used to exist is gone with the band.
    expect(
      ruleBody(NAV_CSS, '.navtree-group > .navtree-ws-row[data-active="true"]:hover', true),
    ).toBe('');
  });

  it('separates workspaces with a BANDED HEADER, not a rule and not only air', () => {
    // This asserted "nothing rules off one group from the next", and the
    // measurement behind it still stands: `--border` against the rail is
    // 1.00:1 on alucard (#ddd8ee on #ddd8ef), 1.06 on acme, 1.14 on
    // github-light. A hairline here is invisible on half the themes and noise
    // on the rest, so there is still no border — that half is unchanged.
    //
    // What changed is the other half. 18px of pure air left the rail reading as
    // one long list with some bold words in it, reported as workspaces not
    // feeling like a 'thing'. The separation is now the HEADER's own band —
    // derived from `--fg`, which cannot be invisible on a theme whose text has
    // to be readable — so the air can shrink and the groups still part.
    const body = ruleBody(NAV_CSS, '.navtree-group + .navtree-group');
    expect(body).not.toMatch(/border-top:\s*1px/);
    expect(Number.parseFloat(decl(body, 'margin-top'))).toBeGreaterThanOrEqual(8);
    // The CARD is what does the work now — see the group rule. The header's own
    // band is gone: inside a card it was redundant (the card already separates
    // the group) and the wrong colour (it tinted the RAIL's surface, not the
    // card's). All the header still owes is opacity, or rows scroll through it.
    //
    // ONE token, read twice. The card and its sticky header must be the same
    // colour, and writing the mix out in both places is the
    // two-surfaces-deriving-one-value bug this file has caught before — a
    // header a shade off its own card is a seam the width of the header.
    const band = ruleBody(NAV_CSS, '.navtree-group > .navtree-ws-row');
    expect(decl(band, 'background-color')).toBe('var(--nt-surface)');
    expect(decl(band, 'position')).toBe('sticky');
    // Mixed from --fg, not from a surface token: the band has to be visible on a
    // near-black rail and a cream one, and the foreground is the only value
    // guaranteed to have range over both — the rail's text has to be readable
    // there by definition. Chained through the TRAY now, so the header can
    // never be a shade the card is not. See the tray test for the arithmetic.
    expect(NT_TOKENS['--nt-group-head']).toBeUndefined();
    expect(NT_TOKENS['--nt-trough']).toBeUndefined();
  });
  it('the fillets are in ::after, because ::before is already somebody else’s', () => {
    // THE BUG THIS EXISTS FOR, which was on screen and was reported as a pale
    // notch beside the selected row. StateChip.css reserves `::before` on EVERY
    // `.navtree-tab-row` as the 3px left state track, and pins it with
    // `left: var(--nt-pad)`. The fillet rule then added `right` + `width` to
    // the SAME pseudo — over-constrained in the inline direction, so the
    // browser keeps `left` and discards `right`. The top fillet rendered on the
    // row's LEFT edge; the corner it was supposed to round stayed square, while
    // the bottom one (in `::after`, unclaimed) looked perfect. One corner right
    // and one wrong is the signature, and it is invisible to any test that only
    // reads the rule it wrote.
    //
    // So the invariant is ownership, not geometry: NavTree.css does not style
    // `::before` on a tab row at all, and the fillet that replaced it declares
    // `left: auto` so it can never be over-constrained again by a third party.
    const nav = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const beforeOwners = (nav.match(/[^{}]*\{[^}]*\}/g) ?? [])
      .map((r) => r.slice(0, r.indexOf('{')).trim())
      .filter((sel) => /\.navtree-tab-row(?!-)[^,{]*::before/.test(sel))
      // The sub-chat trunk is drawn on the CHILD row's ::before and is the one
      // sanctioned exception — it is a different row and a different axis.
      .filter((sel) => !sel.includes('[data-child="true"]'));
    expect(beforeOwners).toEqual([]);

    const fillet = ruleBody(NAV_CSS, '.navtree-tab-row[data-active="true"]::after');
    expect(decl(fillet, 'left')).toBe('auto');
    expect(decl(fillet, 'right')).toContain('--nt-pad');
    // Both corners, one box: the overhang reaches 18px past the row at each end
    // and the two quarter-discs are background LAYERS pinned to its corners.
    expect(decl(fillet, 'top')).toBe('-18px');
    expect(decl(fillet, 'bottom')).toBe('-18px');
    expect(decl(fillet, 'background-image').match(/radial-gradient/g)).toHaveLength(2);
    expect(decl(fillet, 'background-image')).toContain('--bg-pane-face');
  });
  it('the group has NO SURFACE — air and a label carry it, and the row keeps its contrast', () => {
    // "i still yearn for more grouping of workspaces", then "bad contrast of
    // bg", then "not good". Three attempts, each measured, each failing for its
    // own reason, and the sequence is the argument for where this landed:
    //
    //   1 · a tinted TRAY (--fg 8% over the rail). Mixing a surface toward --fg
    //       moves every row's background toward its own ink: text contrast fell
    //       on all six themes (11.30 → 9.77 alucard, 12.61 → 10.87
    //       github-light) and github-light's DIM ink went 4.88 → 4.21, under
    //       the AA floor. --fg also flips with the theme, so one percentage
    //       RECESSED the tray on three themes and RAISED it on the other three.
    //   2 · a tinted TROUGH. Fixed the contrast — the tint sat on the gap,
    //       which has no text — but left FOUR surfaces (rail, trough, tray,
    //       header band) within a few ΔE of one another. That is a flat field
    //       with faint lines in it, not a hierarchy.
    //   3 · no group surface at all, which is what every reference describes:
    //       group with air and a muted label, and spend the one surface you
    //       have on the one thing that is selected.
    //
    // So the assertions are NEGATIVE on purpose. Each one is a thing that was
    // tried, shipped, and reported.
    const group = ruleBody(NAV_CSS, '.navtree-group');
    expect(group).not.toMatch(/background/);
    expect(group).not.toMatch(/border-radius/);
    expect(group).not.toMatch(/box-shadow/);
    expect(group).not.toMatch(/--accent/);
    expect(ruleBody(NAV_CSS, '.navtree-scroll')).not.toMatch(/background-color/);

    // The sticky header is OPAQUE but not tinted. Opacity is the entire
    // requirement — rows must not scroll through the label — and a band was
    // over-paying for it.
    const head = ruleBody(NAV_CSS, '.navtree-group > .navtree-ws-row');
    expect(decl(head, 'position')).toBe('sticky');
    expect(decl(head, 'background-color')).toBe('var(--nt-surface)');

    // And the label is a LABEL: smaller than the rows it heads, not larger,
    // and set apart by case rather than by a surface. It used to be the same
    // size as a chat and heavier, which is why three workspaces read as three
    // more list items instead of as three containers.
    const label = ruleBody(NAV_CSS, '.navtree-ws-row .navtree-name-text');
    expect(decl(label, 'text-transform')).toBe('uppercase');
    expect(Number.parseFloat(decl(label, 'font-size'))).toBeLessThan(13);
    expect(decl(label, 'color')).toBe('var(--fg-dim)');
    expect(decl(ruleBody(NAV_CSS, '.navtree-ws-row[data-active="true"] .navtree-name-text'), 'color')).toBe(
      'var(--fg)',
    );

    // Air is now the whole separating device, so it has to be a real amount.
    expect(
      Number.parseFloat(decl(ruleBody(NAV_CSS, '.navtree-group + .navtree-group'), 'margin-top')),
    ).toBeGreaterThanOrEqual(24);

    // THE ROW'S CONTRAST IS UNTOUCHED, on every theme — this is the assertion
    // attempt 1 failed and the reason the tint is not on a reading surface.
    for (const [name, t] of Object.entries(THEMES)) {
      const onRow = ratio(t['--fg'] as string, t['--bg-tabbar'] as string);
      expect({ name, aa: onRow >= 4.5 }).toEqual({ name, aa: true });
    }
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
    // AND A STUB. Inset-both-ends still spanned 240 of the rail's 268px, which
    // reads as a cut however it is inset — reported a second time against the
    // inset version. A fixed, short width is the thing being asserted, because
    // every margin-based attempt at this has drifted back toward full width.
    expect(Number.parseFloat(decl(body, 'width'))).toBeLessThanOrEqual(64);
  });
});
