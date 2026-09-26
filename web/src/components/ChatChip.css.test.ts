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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatChip, type ChatChipChat } from './ChatChip';

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

/**
 * NOTHING IN THIS SHEET IS INERT — the guard the CSS tests were missing.
 *
 * A stylesheet test is only worth its run time if the selectors it reasons about
 * match something the product actually draws, and this branch shipped the
 * counter-example: the sidebar's child-row geometry was pinned to the pixel while
 * `data-child="true"` was emitted on no element anywhere (R2-9), and the dot rules
 * below were therefore dead too. Correct rules, passing tests, a feature that did
 * not exist. A test that cannot fail is worse than no test, because it defends
 * the bug.
 *
 * So: draw every state the chip has, and require every selector in the sheet to
 * match at least one of them. A rule for a state the component cannot produce —
 * or a class/attribute renamed on one side of the seam only — fails here.
 *
 * (The rail's own half of the same guard is NavTree.rows.test.tsx, which asserts
 * the `data-child` row and the dot reach the DOM at all.)
 */
describe('every selector in the sheet matches something the chip can draw', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;
  /** A clock as the SERVER publishes it — same fixture shape as ChatChip.test. */
  const clock = (days: number, over: Partial<ChatChipChat> = {}): ChatChipChat => ({
    name: 'chat',
    icon: '📈',
    clock: {
      started_at: NOW - days * DAY,
      expires_at: NOW - days * DAY + 4 * DAY,
      fill: days / 4,
      last_day: days >= 3,
      stopped: false,
    },
    ...over,
  });

  /** Every phase, both shapes, all three densities — one detached DOM. */
  function drawEverything(): HTMLElement {
    const box = document.createElement('div');
    box.innerHTML = [
      // Tiles: fresh, ageing, last day, done, pinned.
      renderToStaticMarkup(createElement(ChatChip, { density: 'row', chat: clock(0) })),
      renderToStaticMarkup(createElement(ChatChip, { density: 'row', chat: clock(1) })),
      renderToStaticMarkup(createElement(ChatChip, { density: 'row', chat: clock(3) })),
      renderToStaticMarkup(
        createElement(ChatChip, { density: 'row', chat: clock(4, { done: true }) }),
      ),
      renderToStaticMarkup(
        createElement(ChatChip, { density: 'row', chat: { name: 'p', pinned: true } }),
      ),
      // The child dot, in both of its two states.
      renderToStaticMarkup(
        createElement(ChatChip, {
          density: 'row',
          chat: { name: 'kid', spawned_by: 'p', done: false },
        }),
      ),
      renderToStaticMarkup(
        createElement(ChatChip, {
          density: 'row',
          chat: { name: 'kid', spawned_by: 'p', done: true },
        }),
      ),
      // Densities are SIZE only, but each has its own rule to be reached.
      renderToStaticMarkup(createElement(ChatChip, { density: 'card', chat: clock(1) })),
      renderToStaticMarkup(createElement(ChatChip, { density: 'chip', chat: clock(1) })),
    ].join('');
    return box;
  }

  /**
   * Every selector in the sheet. Heads starting with `@` are at-rules, not
   * selectors — their nested rules are picked up on the next pass of the same
   * scan, so a @media block contributes its contents and not its condition.
   */
  const selectors = [...bare(CHIP_CSS).matchAll(/([^{}]*)\{/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((head) => head.length > 0 && !head.startsWith('@'))
    .flatMap((head) => head.split(',').map((s) => s.trim()))
    .filter((s) => s.length > 0);

  it('finds the sheet’s selectors at all (so the sweep cannot pass vacuously)', () => {
    // Guards the guard. The sheet has ~12 rules; a parser that silently returned
    // nothing would make every assertion below trivially true.
    expect(selectors.length).toBeGreaterThanOrEqual(10);
    expect(selectors).toContain('.chatchip-dot[data-hollow="true"]');
    expect(selectors).toContain('.chatchip[data-shape="dot"]');
  });

  it.each(selectors)('%s', (selector) => {
    const box = drawEverything();
    // `:not(:empty)`-style functional pseudos would need a live layout; this
    // sheet has none, so querySelectorAll is the engine's own answer.
    expect(box.querySelectorAll(selector).length).toBeGreaterThan(0);
  });
});
