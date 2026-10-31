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

/**
 * NO THEME SETS A CONDENSED FACE ON TEXT.
 *
 * Blueprint took three rounds to learn this and the lesson generalises: a
 * condensed face is a DISPLAY face. It is for a title block set once at size,
 * not for a token spent on body copy (round one: "extremely hard to read"),
 * nor on a rail of thirty proper nouns at 13px (round two: "sidebar font too
 * narrow"), nor on `--chrome-font`, which is not two labels — it is every
 * chip, action row, tool row, agent block and settings control in the app
 * (round three: "I still see some usage of narrow fonts in this blue theme").
 *
 * What reads as a drafting hand is CAPS and TRACKING, and those are free to
 * apply exactly where the lettering is.
 */
describe('no theme puts a narrow face on text', () => {
  const NARROW = /condensed|narrow|bahnschrift|impact|haettenschweiler|oswald|din alternate/i;
  const cases = THEMES.flatMap((t) => {
    const block = STYLES.match(new RegExp(`\\[data-theme="${t.value}"\\]\\s*\\{([^}]*)\\}`))?.[1];
    if (!block) return [];
    return (['--ui-font', '--chrome-font'] as const).flatMap((tok) => {
      const v = new RegExp(`${tok}:([^;]*);`).exec(block)?.[1];
      return v ? [[`${t.value} ${tok}`, v] as const] : [];
    });
  });

  it('finds the font tokens at all, so this cannot pass vacuously', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
  });

  it.each(cases)('%s', (_name, value) => {
    expect(value).not.toMatch(NARROW);
  });
});

/**
 * EVERY THEME READS AT THE SAME SIZE, WHATEVER FACE IT PICKS.
 *
 * A theme owns the typeface, and no theme sets a font-size — yet memphis read
 * visibly larger than riso at identical declarations. What you perceive as
 * "size" is x-height, not the em box, and the faces in use are far apart on
 * it: Verdana 0.545 (memphis), system ~0.52, Helvetica Neue 0.517 (riso),
 * Avenir Next 0.473 (blueprint). So memphis ran ~5% large and blueprint ~9%
 * small. Reported as "some of the themes changed the font sizes
 * meaningfully… I prefer riso, which I believe uses the size most of the
 * other themes use".
 */
describe('the type scale survives a change of typeface', () => {
  const bare = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');

  it('normalises x-height on the body, to riso’s face', () => {
    const body = bare.slice(bare.indexOf('\nbody {'));
    expect(body.slice(0, body.indexOf('}'))).toMatch(/font-size-adjust:\s*0\.517/);
  });

  it('still lets a theme own the typeface — this is not a font lock', () => {
    // The point is that picking a face stops changing the SIZE, not that a
    // theme stops picking one.
    expect(bare).toMatch(/\[data-theme="memphis"\][\s\S]{0,400}--ui-font:\s*Verdana/);
    expect(bare).toMatch(/\[data-theme="riso"\][\s\S]{0,400}--ui-font:\s*"Helvetica Neue"/);
  });

  it('exempts the bitmap face, which has no sizes between its own', () => {
    // Px437 IBM VGA is an 8x16 pixel font: correct at its integer sizes and
    // blurred at everything else. An x-height ratio lands between them by
    // definition.
    expect(bare).toMatch(/\[data-theme="demoscene"\][^{]*\{[^}]*font-size-adjust:\s*none/);
  });

  it('exempts the terminal, which measures its own cell', () => {
    // xterm.js computes a character box from the computed style and lays the
    // grid on it; shifting glyphs under that measurement is how a TUI starts
    // drawing boxes that do not meet.
    expect(bare).toMatch(/\.xterm[^{]*\{[^}]*font-size-adjust:\s*none/);
  });
});

/**
 * …AND A WORDMARK IS A LOGO, NOT PROSE.
 *
 * Normalising its x-height is the same mistake as doing it to the bitmap
 * face: a lockup is drawn at a size and a weight somebody chose. A theme that
 * sets the brand in a small-x-height display face (Gill Sans at 0.46 —
 * memphis, riso) had it scaled up ~12% inside a row whose height is pinned to
 * the pane's tab strip, and the wordmark ended up pressed against its own
 * row: "just doesn't look good, a bit squished".
 */
describe('the brand opts out of the x-height normalisation', () => {
  it('exempts the wordmark and the mark', () => {
    const bare = STYLES.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(bare).toMatch(/\.brand-text,\s*\.brand-mark \{\s*font-size-adjust:\s*none/);
  });
});
