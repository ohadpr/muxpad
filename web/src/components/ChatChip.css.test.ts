import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The clock's INK, as a two-part token — and where each part has to live.
 *
 * This file exists because the bug it guards renders perfectly in the app while
 * being wrong. `--clock` is `color-mix(accent 34%, var(--clock-base))`, and a
 * custom property is substituted on the element that DECLARES it. Declared at
 * `:root`, it resolves against :root's base and inherits down as a finished
 * colour, so every per-theme override arrives too late — measured: all six
 * themes rendered the identical #526595.
 *
 * It would have shipped anyway, because muxpad sets `data-theme` on
 * documentElement (settings.ts), which is the one element where `:root` and the
 * theme rule are the same place, so the app happens to hit the case that works.
 * A screenshot proves nothing here; only where the declaration sits does.
 */
const css = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const CHIP_CSS = css('ChatChip.css');
const STYLES = css('../styles.css');

/** Strip comments — prose about a token is not a declaration of one. */
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

describe('--clock is declared where it can see the theme', () => {
  it('lives on .chatchip, and NOT at :root', () => {
    expect(bare(CHIP_CSS)).toMatch(/--clock:\s*color-mix\(/);
    // The whole bug, in one assertion.
    expect(bare(STYLES)).not.toMatch(/--clock:/);
  });

  it('is the accent cut to 34% with the per-theme base', () => {
    const decl = bare(CHIP_CSS).match(/--clock:\s*([^;]+);/)?.[1];
    expect(decl).toContain('var(--accent) 34%');
    expect(decl).toContain('var(--clock-base)');
  });
});

describe('every theme re-steps the clock base', () => {
  /** Each `[data-theme="x"] { … }` block in styles.css. */
  const themes = [...bare(STYLES).matchAll(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)].map(
    (m) => ({ name: m[1] as string, body: m[2] as string }),
  );

  it('finds the themes at all (so the sweep below cannot pass vacuously)', () => {
    expect(themes.length).toBeGreaterThanOrEqual(6);
  });

  it.each(themes.map((t) => t.name))('%s defines its own --clock-base', (name) => {
    const body = themes.find((t) => t.name === name)?.body ?? '';
    expect(body).toMatch(/--clock-base:\s*#[0-9a-f]{6}/i);
  });

  it(':root carries a base too, as the floor', () => {
    // Without it, a surface outside any theme block renders the mix against
    // nothing and the fill disappears entirely.
    const root = bare(STYLES).match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(root).toMatch(/--clock-base:\s*#[0-9a-f]{6}/i);
  });

  it('keeps the colour the user actually approved on alucard', () => {
    // alucard IS the prototype's palette, and #d9d3ea is the pale lilac the
    // chip was drawn against through eight rounds. Every other theme is a
    // re-step of this one; this one is not up for re-derivation.
    const alucard = themes.find((t) => t.name === 'alucard')?.body ?? '';
    expect(alucard).toMatch(/--clock-base:\s*#d9d3ea/i);
  });
});
