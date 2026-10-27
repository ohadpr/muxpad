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
        r.sel.includes('[data-theme=') && /\.navtree-tab-row\[data-active="true"\]\s*$/.test(r.sel),
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
