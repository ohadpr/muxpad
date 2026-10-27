import { readFileSync } from 'node:fs';
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
    expect(SETTINGS_TSX).toMatch(/name="theme"/);
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
