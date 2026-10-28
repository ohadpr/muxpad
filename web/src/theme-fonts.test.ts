import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES } from './settings';

/**
 * A THEME CAN OWN THE TYPEFACE, NOT JUST THE PALETTE.
 *
 * Every theme before demoscene repainted a UI whose shapes never moved — same
 * proportional sans in the rail, same terminal font — because `--ui-font`,
 * `--chrome-font` and the terminal's family were fixed outside the theme
 * layer. A look like "demoscene" is carried by the typeface at least as much
 * as by colour, so those moved into the theme.
 *
 * Two things have to keep holding for that to mean anything, and neither is
 * visible in a screenshot:
 *   · the tokens must be the ONLY way the UI names a font, or a theme changes
 *     the app everywhere except the one rule that hardcoded its own; and
 *   · the terminal has to read the token, since it is configured in JS and
 *     would otherwise silently ignore the theme.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, 'styles.css'), 'utf8');

/** Every stylesheet the app ships, so the check cannot miss a component file. */
function allCss(): { file: string; css: string }[] {
  const out: { file: string; css: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // `fonts.css` DECLARES families (@font-face); it does not choose one.
      if (e.name === 'fonts' || e.name === 'fonts.css' || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css')) out.push({ file: e.name, css: readFileSync(p, 'utf8') });
    }
  };
  walk(HERE);
  return out;
}

describe('fonts are a theme token', () => {
  it('declares a terminal-font token with the system default', () => {
    // The default has to stay a SYSTEM font: the terminal is configured in JS
    // and measures a cell at startup, so a webfont here costs a re-measure.
    expect(STYLES).toMatch(/--term-font:\s*Menlo/);
  });

  it('the demoscene theme sets all three font tokens', () => {
    const block = STYLES.match(/\[data-theme="demoscene"\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).toMatch(/--ui-font:/);
    expect(block).toMatch(/--chrome-font:/);
    expect(block).toMatch(/--term-font:/);
  });

  it('names no webfont in a theme font stack — the phone pays for those', () => {
    // fonts.css ships MesloLGS NF at ~1 MB a face, lazily. A theme is free to
    // NAME it (it is declared, and a user who has it installed gets it), but
    // the stack must end in system families so nothing is fetched to render
    // the chrome. The terminal stack must not name it at all.
    const term = STYLES.match(/\[data-theme="demoscene"\][^}]*--term-font:([^;]*);/)?.[1] ?? '';
    expect(term).not.toMatch(/MesloLGS/);
    expect(term).toMatch(/Menlo|monospace/);
  });

  it('every font-family in the app goes through a token', () => {
    // The rule this guards is the one that was already broken once: a
    // hardcoded `-apple-system, …` stack in styles.css meant a theme could
    // repaint the whole app except that element.
    const offenders: string[] = [];
    for (const { file, css } of allCss()) {
      for (const m of css.matchAll(/font-family:\s*([^;]+);/g)) {
        const value = (m[1] as string).trim();
        if (value.startsWith('var(') || value === 'inherit') continue;
        // ExternalOpenToasts names the Nerd Font on purpose: it renders glyphs
        // no system family has, which is a CONTENT requirement, not a style.
        if (file === 'ExternalOpenToasts.css' && value.includes('ui-monospace')) continue;
        offenders.push(`${file}: ${value.slice(0, 48)}`);
      }
    }
    expect(offenders, 'these bypass --ui-font/--chrome-font').toEqual([]);
  });

  it('the picker offers the theme, and the terminal has a palette for it', async () => {
    expect(THEMES.map((t) => t.value)).toContain('demoscene');
    // Record<Theme, …> makes this a type error too; asserted because the type
    // only binds at build time and a palette can still be wrong at runtime.
    const pane = readFileSync(join(HERE, 'components', 'XtermPane.tsx'), 'utf8');
    expect(pane).toMatch(/demoscene:\s*\{/);
    expect(pane).toMatch(/resolvedTerminalFont\(\)/);
  });
});

/**
 * A CHARACTER GRID NEEDS A MONOSPACE TOKEN, AND --chrome-font IS NOT ONE.
 *
 * `--chrome-font` is the face a theme owns for its small chrome, and since
 * themes started owning typefaces it is routinely PROPORTIONAL — blueprint's
 * condensed drafting hand, riso's Futura, memphis's Gill Sans. The BASE value
 * is monospace, which is exactly why this went unnoticed: on the seven themes
 * that do not override it everything looked right, and on the ones that do,
 * every code block in the app rendered in a proportional face with its columns
 * out of line. Reported as "font of text code blocks too narrow, maybe it's
 * not even monospaced".
 *
 * `--term-font` is the token that means "this theme's monospace": every theme
 * sets it, the terminal reads it, and the test above requires its default to
 * stay a system mono.
 */
describe('anything with columns uses the monospace token', () => {
  const chat = readFileSync(join(HERE, 'components', 'ChatPane.css'), 'utf8');
  const body = (selector: string): string => {
    const flat = chat.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = new RegExp(
      `(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
      'm',
    );
    return re.exec(flat)?.[1] ?? '';
  };

  it.each([
    ['.chat-md pre code', 'a fenced code block'],
    ['.chat-md :not(pre) > code', 'inline code'],
    ['.chat-modal-block', 'tool output'],
    ['.chat-diff', 'a diff'],
  ])('%s — %s', (selector) => {
    const rule = body(selector);
    expect(rule, `${selector} not found`).not.toBe('');
    expect(rule).toMatch(/font-family:\s*var\(--term-font/);
    expect(rule).not.toMatch(/font-family:\s*var\(--chrome-font/);
  });

  it('every theme that renames --chrome-font still ships a MONOSPACE --term-font', () => {
    // The two tokens are independent on purpose: a theme may letter its chrome
    // however it likes, and must not be able to take the grid with it.
    for (const t of THEMES) {
      const block = STYLES.match(new RegExp(`\\[data-theme="${t.value}"\\]\\s*\\{([^}]*)\\}`))?.[1];
      const term = /--term-font:([^;]*);/.exec(block ?? '')?.[1];
      if (!term) continue; // inherits the base, which the test above pins
      expect(term, `${t.value}'s --term-font`).toMatch(/mono|Menlo|Monaco|Courier|Consolas/i);
    }
  });
});
