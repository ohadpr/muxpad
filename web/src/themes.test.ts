import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES } from './settings';

/**
 * A THEME IS REGISTERED IN FOUR PLACES, AND THREE OF THEM FAIL SILENTLY.
 *
 * The picker reads `THEMES`. The palette lives in styles.css. The terminal
 * keeps its own map in XtermPane, because xterm.js is configured in JS and
 * cannot read a CSS variable. Miss any of the last three and the theme still
 * APPEARS in the list — it just paints the previous theme's app, or a black
 * terminal inside a cream one, and nothing anywhere says so.
 *
 * The existing sweeps (ChatChip, NavSearch, NavTree) all discover themes by
 * scraping the STYLESHEET, so a theme that is in the list and nowhere else is
 * invisible to every one of them. This file starts from the list instead.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, 'styles.css'), 'utf8');
const XTERM = readFileSync(join(HERE, 'components', 'XtermPane.tsx'), 'utf8');
const SETTINGS_TSX = readFileSync(join(HERE, 'components', 'SettingsMenu.tsx'), 'utf8');
/** Comments stripped: prose ABOUT a declaration is not one, and both checks
 *  below are about what the sheet does rather than what it says. */
const SETTINGS_CSS = readFileSync(join(HERE, 'components', 'SettingsMenu.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The token block for one theme — the `[data-theme="x"] { … }` rule. */
const block = (name: string): string =>
  STYLES.match(new RegExp(`\\[data-theme="${name}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? '';

/** Everything a theme must colour. A missing one inherits the theme the user
 *  was on BEFORE, which is the worst possible failure: it looks deliberate. */
const REQUIRED = [
  '--bg',
  '--bg-elev',
  '--bg-hover',
  '--bg-chrome',
  '--bg-tabbar',
  '--fg',
  '--fg-dim',
  '--fg-faint',
  '--border',
  '--border-strong',
  '--accent',
  '--accent-fg',
  '--danger',
  '--rail-surface',
  '--rail-ink',
  '--rail-ink-dim',
  '--rail-ink-faint',
  '--rail-hover',
  '--rail-border',
  '--rail-accent',
  '--rail-status-ready',
  '--rail-status-working',
  '--xterm-bg',
  '--xterm-fg',
  '--clock-base',
  '--hit-bg',
  '--hit-ink',
  '--hit-rule',
];

describe('every theme the picker offers', () => {
  it('finds the themes at all, so the sweep cannot pass vacuously', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(9);
  });

  it.each(THEMES.map((t) => t.value))('%s has a block in the stylesheet', (name) => {
    expect(block(name), `no [data-theme="${name}"] rule`).not.toBe('');
  });

  it.each(THEMES.map((t) => t.value))('%s colours everything the app reads', (name) => {
    const body = block(name);
    const missing = REQUIRED.filter((t) => !new RegExp(`${t}:`).test(body));
    expect(missing, `${name} leaves these to whatever was painted before`).toEqual([]);
  });

  it.each(THEMES.map((t) => t.value))('%s has a terminal palette', (name) => {
    // Record<Theme, …> catches this at build time; asserted anyway because a
    // palette can be present and still point at the wrong surface.
    expect(XTERM).toMatch(new RegExp(`'?${name}'?:\\s*\\{`));
  });

  it.each(THEMES.map((t) => t.value))('%s paints its terminal on its own ground', (name) => {
    // The failure this catches is a copy-pasted palette: a light theme with a
    // dark theme's background is a black hole in the middle of a cream app,
    // and nothing in the type system notices.
    const palette = XTERM.match(new RegExp(`'?${name}'?:\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    const bg = palette.match(/background:\s*'(#[0-9a-f]{6})'/i)?.[1];
    expect(bg?.toLowerCase()).toBe(block(name).match(/--xterm-bg:\s*(#[0-9a-f]{6})/i)?.[1]);
  });
});

/**
 * THE PICKER SHOWS THE THEME RATHER THAN NAMING IT, and the only reason it can
 * is that the theme blocks are ATTRIBUTE selectors. A refactor to
 * `:root[data-theme=…]` would leave every tile painting the app's own colours
 * and still pass every test above.
 */
describe('the theme picker previews the real tokens', () => {
  it('the tiles carry data-theme, which is where the palette comes from', () => {
    expect(SETTINGS_TSX).toMatch(/data-theme=\{theme\}/);
  });

  it('no theme block is scoped to :root, or a tile paints the wrong palette', () => {
    for (const t of THEMES)
      expect(STYLES, `${t.value} is :root-scoped`).not.toMatch(
        new RegExp(`:root\\[data-theme="${t.value}"\\]`),
      );
  });

  it('the miniature reads the tokens, never a hex of its own', () => {
    // A hardcoded colour here is a SECOND copy of the palette, and a copy that
    // nothing updates when a theme changes.
    const mock = SETTINGS_CSS.slice(
      SETTINGS_CSS.indexOf('.theme-mock {'),
      SETTINGS_CSS.indexOf('.settings-push-actions'),
    );
    expect(mock).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(mock).toMatch(/var\(--rail-surface\)/);
    expect(mock).toMatch(/var\(--ui-font\)/);
  });

  it('is a radiogroup, not a row of buttons — arrow keys are the point', () => {
    expect(SETTINGS_TSX).toMatch(/type="radio"/);
    // The group NAME is a prop now, because the picker is mounted twice — the
    // settings dialog and the rail's switch — and two radio groups sharing one
    // name are ONE group to the browser: the checked radios fight and arrow
    // keys walk between surfaces. Default `theme`, the rail passes its own.
    expect(SETTINGS_TSX).toMatch(/name=\{group\}/);
    expect(SETTINGS_TSX).toMatch(/group = 'theme'/);
    // display:none would drop the inputs out of the group and take the arrow
    // keys with them; the hidden style must be the clip-path kind.
    const tile = SETTINGS_CSS.slice(
      SETTINGS_CSS.indexOf('.theme-tile input {'),
      SETTINGS_CSS.indexOf('.theme-tile:hover'),
    );
    expect(tile).toMatch(/clip-path/);
    expect(tile).not.toMatch(/display:\s*none/);
  });
});

/**
 * A RULE THAT MATCHES NOTHING LOOKS EXACTLY LIKE A RULE THAT WORKS.
 *
 * Three themes styled `.navtree-ws-label` — uppercase, tracking, and in one
 * case a whole rubber stamp. There is no such element: the workspace name is
 * `.navtree-ws-name > .navtree-name-text`. Nothing failed, nothing warned, and
 * the two earlier themes had shipped with the dead rule for as long as they
 * existed, because the only way to notice is to render the theme and look for
 * a thing you only half expected to see.
 *
 * So: every class a theme block names must exist in the markup.
 */
describe('theme rules point at elements that exist', () => {
  const COMPONENTS = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name))
          out.push(readFileSync(p, 'utf8'));
      }
    };
    walk(HERE);
    return out.join('\n');
  })();

  /** Every `.class` named inside a `[data-theme=…] …` selector. */
  const themed = (): { theme: string; cls: string }[] => {
    const out: { theme: string; cls: string }[] = [];
    for (const m of STYLES.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(
      /\[data-theme="([\w-]+)"\]([^{,]*)[,{]/g,
    )) {
      const [, theme, rest] = m;
      for (const c of (rest ?? '').matchAll(/\.([\w-]+)/g))
        out.push({ theme: theme as string, cls: c[1] as string });
    }
    return out;
  };

  it('finds the themed rules at all', () => {
    expect(themed().length).toBeGreaterThan(20);
  });

  it('names no class the app never renders', () => {
    const dead = [
      ...new Set(
        themed()
          .filter(({ cls }) => !COMPONENTS.includes(cls))
          .map(({ theme, cls }) => `${theme}: .${cls}`),
      ),
    ];
    expect(dead, 'these theme rules match nothing').toEqual([]);
  });
});

/**
 * THE SELECTED ROW IS THE PANE'S SURFACE, REACHING INTO THE RAIL.
 *
 * Not a highlight. `.navtree-tab-row[data-active]` takes `--bg-pane-face` and
 * `.navtree-tab-funnel` draws the two concave fillets that flare one into the
 * other, which is why the row and the pane read as one shape rather than as a
 * list item that happens to be lit.
 *
 * Two themes broke it the same way — riso with a flat pink, memphis with a
 * flat yellow — and the symptom is not the colour, it is the JOIN: the funnel
 * goes on flaring the pane's surface into a row that is no longer that
 * surface, so the edge is abrupt. Reported as "the yellow here or red in
 * another theme look good but the cut is abrupt… theoretically the active
 * colour should be the bg colour of the main view".
 *
 * A theme may paint an IMAGE over the selected row — demoscene's copper bar
 * does, and the face still shows beneath it. It may not replace the colour.
 */
describe('no theme replaces the selected row’s fill', () => {
  const bare = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
  const activeRules = [...bare.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: (m[1] ?? '').trim().replace(/\s+/g, ' '), body: m[2] ?? '' }))
    .filter(
      (r) =>
        r.sel.includes('[data-theme=') &&
        /\.navtree-tab-row\[data-active="true"\]\s*$/.test(r.sel) &&
        // The PHONE's selected row is not the pane's surface: there is no pane
        // beside the full-screen list and no funnel, so its fill is a plain
        // selection and a theme may tune it (wokintosh inverts it). The join
        // this guards exists on the desktop rail only.
        !r.sel.includes('[data-variant="sheet"]'),
    );

  it('finds the rules at all, so this cannot pass vacuously', () => {
    expect(activeRules.length).toBeGreaterThan(0);
  });

  it.each(activeRules.map((r) => [r.sel, r] as const))('%s sets no background-color', (_s, r) => {
    expect(r.body).not.toMatch(/(?:^|;)\s*background-color\s*:/);
    // `background:` shorthand sets the colour too, and resets it to
    // `transparent` even when only an image is given.
    expect(r.body).not.toMatch(/(?:^|;)\s*background\s*:/);
  });
});

/**
 * NOTHING IS PAINTED WHERE THE PANE JOINS THE RAIL.
 *
 * The selected row is the chat pane's own surface continuing into the rail,
 * with `.navtree-tab-funnel` drawing the fillets that flare one into the
 * other. A border on `.sidenav`'s right edge sits outside the padding box of
 * all of it and rules a line straight through that join.
 *
 * Two themes did it — demoscene's box-drawing wall, blueprint's drafting rule
 * — and it is structural rather than a matter of taste: the rail's right edge
 * is WHERE THE PANE JOINS IT. Reported as "remove vertical border line it
 * blocks nice flow of selected tab bg".
 */
describe('no theme walls off the rail', () => {
  const bare = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
  const railRules = [...bare.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: (m[1] ?? '').trim().replace(/\s+/g, ' '), body: m[2] ?? '' }))
    .filter((r) => r.sel.includes('[data-theme=') && /\.sidenav\s*$/.test(r.sel));

  it('no [data-theme] rule gives .sidenav a right border at all', () => {
    const offenders = railRules
      .filter((r) => /border-right\s*:|border-image\s*:|(?:^|;)\s*border\s*:/.test(r.body))
      .map((r) => r.sel);
    expect(offenders, 'these rule a line through the selection’s join').toEqual([]);
  });
});

/**
 * THE RAIL AND THE PANE ARE TWO SURFACES, AND THE EYE MUST BE ABLE TO SAY SO.
 *
 * muxpad's selected row is the pane's surface continuing into the rail. That
 * only reads as continuity if there is something to continue FROM: when the
 * rail and the pane are the same dark, the funnel bridges two halves of one
 * unbroken field and the join is invisible.
 *
 * demoscene measured 1.09:1 — effectively one surface — and was reported as
 * "not good connection of content bg to active chat bg… in general we could
 * use some bg color for content or sidebar". Both halves of that sentence are
 * this number.
 *
 * The floor is 1.25. Every theme that ships clears it with margin (the next
 * lowest is tokyo-night at 1.39), so this fails a NEW theme that forgets,
 * which is the only way it can be forgotten.
 */
describe('every theme separates the rail from the pane', () => {
  const srgb = (hex: string) => {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  };
  const lum = (c: number[]) =>
    c
      .map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      })
      .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const ratio = (a: string, b: string) => {
    const [la, lb] = [lum(srgb(a)), lum(srgb(b))];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  it.each(THEMES.map((t) => t.value))('%s', (name) => {
    const body = block(name);
    const rail = /--rail-surface:\s*(#[0-9a-f]{6})/i.exec(body)?.[1];
    const pane = /--bg:\s*(#[0-9a-f]{6})/i.exec(body)?.[1];
    expect(rail, `${name} has no --rail-surface`).toBeTruthy();
    expect(pane, `${name} has no --bg`).toBeTruthy();
    expect(ratio(rail as string, pane as string)).toBeGreaterThanOrEqual(1.25);
  });
});

/**
 * A LIGHT TERMINAL NEEDS ITS OWN SIXTEEN COLOURS.
 *
 * xterm.js ships ANSI defaults tuned for a black terminal. Five light themes
 * shipped without their own and rendered those defaults on paper: yellow at
 * ~2:1 and white at ~1.1:1, so a test runner's "2 files changed" or a dimmed
 * hint was effectively invisible. Each light theme now carries a full set
 * drawn from its own palette; this holds every slot to text contrast against
 * the terminal's ground, so a new light theme cannot ship the defaults again.
 * Dark themes are exempt: the defaults were made for them.
 */
describe('every light terminal sets a legible ANSI palette', () => {
  const ANSI = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ];
  const lum = (hex: string) =>
    [1, 3, 5]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
      .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const ratio = (a: string, b: string) => {
    const [la, lb] = [lum(a), lum(b)];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const light = THEMES.map((t) => t.value).flatMap((name) => {
    const palette = XTERM.match(new RegExp(`'?${name}'?:\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    const bg = palette.match(/background:\s*'(#[0-9a-f]{6})'/i)?.[1];
    return bg && lum(bg) > 0.5 ? [[name, palette, bg] as const] : [];
  });

  it('finds the light themes at all, so this cannot pass vacuously', () => {
    expect(light.length).toBeGreaterThanOrEqual(6);
  });

  it.each(light)('%s', (_name, palette, bg) => {
    const weak = ANSI.flatMap((k) => {
      const c = palette.match(new RegExp(`\\b${k}:\\s*'(#[0-9a-f]{6})'`, 'i'))?.[1];
      if (!c) return [`${k}: missing`];
      const r = ratio(c, bg);
      return r < 4.5 ? [`${k} ${c} ${r.toFixed(2)}:1`] : [];
    });
    expect(weak, 'these ANSI colours fall back to dark defaults or fail 4.5:1').toEqual([]);
  });
});

/**
 * THE TREE IS READ, NOT GLANCED AT — EVERY ROLE IN IT CLEARS ITS BAR, ON BOTH
 * SURFACES, IN EVERY THEME.
 *
 * "For this tree view esp on mobile but likely always give me better contrast
 * in all themes", with Slack's mobile list as the reference: names in
 * near-black at weight, section headers as black and as bold, separators doing
 * the grouping. Measured before the fix, the list leaned on --fg-dim and
 * --fg-faint for most of what it said, and four roles were under the bar
 * outright: "+ New workspace" at 1.94–3.83:1 in ten themes (accent at 70%
 * opacity, 12px), the section chevron at 2.62–2.97:1 on the phone in four,
 * and the count chip at 4.36 and 4.45:1.
 *
 * One NavTree draws two surfaces with different inks. The desktop rail is an
 * ISLAND: `.navtree[data-variant="sidebar"]` rebinds --fg/--fg-dim/--accent to
 * the theme's --rail-* values on --rail-surface. The phone list keeps the
 * app's own inks on --nt-surface. A role that reads on a deep rail can wash
 * out on the phone's flat ground and vice versa, so both are resolved here
 * from the same declarations the browser uses, and both are held.
 *
 * The bar is WCAG's: 4.5:1 for text — none of these is large text, bold
 * included, since WCAG's bold exemption starts at 14pt (18.66px) — and 3:1
 * for a glyph that carries meaning (the chevron, the status marks). The one
 * DELIBERATELY quiet role is the older-chats row: retired chats sit one rung
 * down on --fg-dim, still held to 4.5. Quiet is a rung, not a fade.
 */
describe('every theme’s tree reads, rail and phone', () => {
  const NAV = readFileSync(join(HERE, 'components', 'NavTree.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const SHEET = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
  const MOBILE = readFileSync(join(HERE, 'components', 'MobileNav.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  type RGBA = [number, number, number, number];
  type Ctx = Record<string, string>;

  /** Declarations of the rule whose selector LIST contains `sel` exactly. */
  const rulesFor = (css: string, sel: string): Ctx[] =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] ?? '').split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel))
      .map((m) => {
        const out: Ctx = {};
        for (const d of (m[2] ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g))
          out[d[1] as string] = (d[2] as string).trim();
        return out;
      });
  const decl = (css: string, sel: string, prop: string): string | undefined =>
    rulesFor(css, sel)
      .map((r) => r[prop])
      .filter(Boolean)
      .pop();

  const tokens = (body: string): Ctx => {
    const out: Ctx = {};
    for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      out[d[1] as string] = (d[2] as string).trim();
    return out;
  };
  const ROOT = tokens(SHEET.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '');
  const NAVROOT = rulesFor(NAV, '.navtree').reduce((a, r) => Object.assign(a, r), {} as Ctx);

  const hex = (h: string): RGBA => {
    const x = h.slice(1);
    const f = x.length <= 4 ? [...x].map((c) => c + c).join('') : x;
    const n = (i: number) => Number.parseInt(f.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), f.length === 8 ? n(6) / 255 : 1];
  };
  /** Split on top-level commas. */
  const args = (s: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of s) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const resolve = (expr: string, ctx: Ctx, depth = 0): RGBA => {
    const e = expr.trim();
    if (depth > 30) throw new Error(`cycle at ${e}`);
    if (e === 'transparent') return [0, 0, 0, 0];
    if (e.startsWith('#')) return hex(e);
    const v = /^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(e);
    if (v) {
      const val = ctx[v[1] as string];
      if (val !== undefined) return resolve(val, ctx, depth + 1);
      if (v[2]) return resolve(v[2], ctx, depth + 1);
      throw new Error(`unset ${v[1]}`);
    }
    const m = /^color-mix\(in srgb,\s*(.+)\)$/.exec(e);
    if (m) {
      const [a, b] = args(m[1] as string).map((p) => {
        const pm = /^(.*?)\s+([\d.]+)%$/.exec(p);
        return pm ? { c: pm[1] as string, p: Number(pm[2]) / 100 } : { c: p, p: Number.NaN };
      }) as [{ c: string; p: number }, { c: string; p: number }];
      const pa = Number.isNaN(a.p) ? 1 - b.p : a.p;
      const ca = resolve(a.c, ctx, depth + 1);
      const cb = resolve(b.c, ctx, depth + 1);
      // Premultiplied, as the spec mixes.
      const al = ca[3] * pa + cb[3] * (1 - pa);
      if (al === 0) return [0, 0, 0, 0];
      const ch = (i: number) => (ca[i]! * ca[3] * pa + cb[i]! * cb[3] * (1 - pa)) / al;
      return [ch(0), ch(1), ch(2), al];
    }
    throw new Error(`cannot resolve ${e}`);
  };
  const over = (t: RGBA, u: RGBA): RGBA => [
    t[0] * t[3] + u[0] * (1 - t[3]),
    t[1] * t[3] + u[1] * (1 - t[3]),
    t[2] * t[3] + u[2] * (1 - t[3]),
    1,
  ];
  const lum = (c: RGBA) =>
    c
      .slice(0, 3)
      .map((x) => x / 255)
      .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
      .reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i]!, 0);
  const ratio = (a: RGBA, b: RGBA) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  const lit = (c: RGBA) =>
    `#${c
      .slice(0, 3)
      .map((n) => Math.round(n).toString(16).padStart(2, '0'))
      .join('')}${Math.round(c[3] * 255)
      .toString(16)
      .padStart(2, '0')}`;

  /** The two surfaces, as the browser builds them. */
  const surfaces = (theme: string) => {
    const pane: Ctx = { ...ROOT, ...tokens(block(theme)) };
    // The rail island: its rebinds resolve against the PANE's values (that is
    // where a custom property is substituted), then the tree's own tokens
    // resolve lazily against the island.
    const islandOf = (css: string, sel: string): Ctx => {
      const out: Ctx = { ...pane };
      for (const r of rulesFor(css, sel))
        for (const [k, v] of Object.entries(r))
          if (k.startsWith('--')) out[k] = lit(resolve(v, pane));
      return out;
    };
    const rail = islandOf(NAV, '.navtree[data-variant="sidebar"]');
    // The phone's list is the rail in another container (MobileNav.css): the
    // island is `.mobile-chat-list`, and the ground is whatever the sheet's
    // sticky surface resolves to INSIDE it.
    const phone = islandOf(MOBILE, '.mobile-chat-list');
    const sheetSurface = decl(NAV, '.navtree[data-variant="sheet"]', '--nt-surface') ?? 'var(--bg)';
    return [
      { name: 'rail', ctx: { ...rail, ...NAVROOT }, ground: resolve('var(--rail-surface)', pane) },
      { name: 'phone', ctx: { ...phone, ...NAVROOT }, ground: resolve(sheetSurface, phone) },
    ] as const;
  };

  /** Each role: where its ink is declared (most specific last), its fill, its
   *  bar. `phone` lists the sheet-only rule that overrides the base there. */
  const ROLES: {
    role: string;
    base: string;
    phone?: string;
    fill?: string;
    /** A rule whose custom properties re-point tokens for this role, and
     *  whose background-color is laid over the ground. */
    scope?: string;
    only?: 'rail' | 'phone';
    bar: number;
  }[] = [
    { role: 'section header', base: '.navtree-ws-row .navtree-name-text', bar: 4.5 },
    {
      role: 'chat name (read)',
      base: '.navtree-tab-row',
      phone: '.navtree[data-variant="sheet"] .navtree-tab-row',
      bar: 4.5,
    },
    {
      role: 'chat name (unread)',
      base: '.navtree-tab-row[data-unread="true"] .navtree-name-text',
      bar: 4.5,
    },
    {
      role: 'older chat (quiet)',
      base: '.navtree-done-head ~ .navtree-tab-row:not([data-active="true"]) .navtree-name-text',
      bar: 4.5,
    },
    { role: 'older chats disclosure', base: '.navtree-done-head', bar: 4.5 },
    { role: 'count chip', base: '.navtree-ws-count', fill: 'background', bar: 4.5 },
    { role: 'Artifacts / Apps', base: '.navtree-foot-link', bar: 4.5 },
    { role: '+ New workspace', base: '.navtree-add', bar: 4.5 },
    { role: 'section chevron', base: '.navtree-disclosure', bar: 3 },
    { role: 'mark: ready', base: '.navtree-mark[data-state="ready"]', bar: 3 },
    { role: 'mark: blocked', base: '.navtree-mark[data-state="blocked"]', bar: 3 },
    { role: 'mark: dead', base: '.navtree-mark[data-state="dead"]', bar: 3 },
    {
      role: 'chat name (selected)',
      base: '.navtree[data-variant="sheet"] .navtree-tab-row[data-active="true"] .navtree-name-text',
      scope: '.navtree[data-variant="sheet"] .navtree-tab-row[data-active="true"]',
      only: 'phone',
      bar: 4.5,
    },
  ];

  /** A theme may restate a role's ink (memphis and wokintosh set the section
   *  name to --fg); the theme's rule wins over the base, as in the browser. */
  const THEME_ALIASES: Record<string, string[]> = {
    'section header': ['.navtree-ws-name .navtree-name-text', '.navtree-ws-row .navtree-name-text'],
  };
  const themed = (theme: string, role: string, base: string) => {
    for (const sel of [...(THEME_ALIASES[role] ?? []), base]) {
      const c = decl(SHEET, `[data-theme="${theme}"] ${sel}`, 'color');
      if (c) return c;
    }
    return undefined;
  };

  const cases = THEMES.flatMap((t) =>
    ROLES.flatMap((r) =>
      surfaces(t.value)
        .filter((s) => !r.only || r.only === s.name)
        .map((s) => [`${t.value} · ${s.name} · ${r.role}`, t.value, r, s] as const),
    ),
  );

  it('covers every theme, both surfaces, every role', () => {
    const both = ROLES.filter((r) => !r.only).length;
    expect(cases.length).toBe(THEMES.length * (both * 2 + ROLES.length - both));
  });

  it.each(cases)('%s', (_n, theme, r, s) => {
    const ink =
      themed(theme, r.role, r.base) ??
      (s.name === 'phone' && r.phone ? decl(NAV, r.phone, 'color') : undefined) ??
      decl(NAV, r.base, 'color');
    expect(ink, `${r.base} declares no colour`).toBeTruthy();
    let ctx: Ctx = s.ctx;
    let ground: RGBA = s.ground;
    if (r.scope) {
      const scoped = rulesFor(NAV, r.scope).reduce((a, x) => Object.assign(a, x), {} as Ctx);
      ctx = { ...s.ctx };
      for (const [k, v] of Object.entries(scoped))
        if (k.startsWith('--')) ctx[k] = lit(resolve(v, s.ctx));
      // A theme may repaint the selection (wokintosh inverts it); its rule wins.
      const wash =
        decl(SHEET, `[data-theme="${theme}"] ${r.scope}`, 'background-color') ??
        scoped['background-color'];
      if (wash) ground = over(resolve(wash, ctx), ground);
    }
    const fillExpr = r.fill ? decl(NAV, r.base, r.fill) : undefined;
    if (fillExpr) ground = over(resolve(fillExpr, ctx), ground);
    const opacity = Number(decl(NAV, r.base, 'opacity') ?? 1);
    const fg = resolve(ink as string, ctx);
    const seen = over([fg[0], fg[1], fg[2], fg[3] * opacity], ground);
    const h = (c: RGBA) =>
      `#${c
        .slice(0, 3)
        .map((n) => Math.round(n).toString(16).padStart(2, '0'))
        .join('')}`;
    expect(ratio(seen, ground), `${ink} → ${h(seen)} on ${h(ground)}`).toBeGreaterThanOrEqual(
      r.bar,
    );
  });

  it('the phone’s list is the rail: same island as .sidenav, on the rail’s ground', () => {
    // "The chat list view in mobile doesn't use the green background in
    // wokintosh." It was a second island that did not exist — the list sat on
    // --bg-chrome in the pane's ink. These pin it to the rail's, rebind for
    // rebind, so a token added to one island cannot be missed in the other.
    const rebinds = (css: string, sel: string) =>
      Object.fromEntries(
        Object.entries(rulesFor(css, sel).reduce((a, r) => Object.assign(a, r), {} as Ctx)).filter(
          ([k]) => k.startsWith('--'),
        ),
      );
    const sidenav = rebinds(NAV, '.sidenav');
    expect(Object.keys(sidenav).length).toBeGreaterThanOrEqual(10);
    expect(rebinds(MOBILE, '.mobile-chat-list')).toEqual(sidenav);
    expect(decl(MOBILE, '.mobile-chat-list', 'background')).toBe('var(--rail-surface)');
    expect(decl(MOBILE, '.mcl-tabs', 'background')).toBe('var(--rail-surface)');
    expect(decl(NAV, '.navtree[data-variant="sheet"]', '--nt-surface')).toBe('var(--rail-surface)');
    // And the selected row turns back to the rail: the base active rule hands
    // every token to the PANE (on the desktop the row IS the pane), which on
    // the sheet's rail-coloured wash is the same mistake in reverse.
    expect(
      rebinds(NAV, '.navtree[data-variant="sheet"] .navtree-tab-row[data-active="true"]'),
    ).toEqual(sidenav);
  });

  it('read and unread are told apart by WEIGHT, not by fading the read row', () => {
    // Same ink on both — the step is 450/400 → 700. A regression that dims the
    // read row again passes the ratios above and fails here.
    expect(decl(NAV, '.navtree', '--nt-ink-read')).toBe('var(--fg)');
    expect(Number(decl(NAV, '.navtree-tab-row', 'font-weight'))).toBeLessThanOrEqual(450);
    expect(
      Number(decl(NAV, '.navtree-tab-row[data-unread="true"] .navtree-name-text', 'font-weight')),
    ).toBe(700);
  });
});
