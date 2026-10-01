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

/** The body of one rule, by its exact selector list. */
const ruleBody = (sheet: string, selector: string): string => {
  const rules = [...bare(sheet).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.find(
    (m) =>
      (m[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .join(',') === selector,
  );
  return (hit?.[2] ?? '').replace(/\s+/g, ' ').trim();
};
/** One declaration out of a rule body. */
const decl = (body: string, prop: string): string | undefined =>
  body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim();

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
 * A2 — THE GLYPH IS THE CLOCK, and for four days out of five nothing frames it.
 *
 * The shipped tile was 24×24 around a 14px glyph — 2.9× the glyph's area — and
 * both halves of that frame were measured as near-invisible on their own (a
 * 1.16:1 fill, a 1.20:1 hairline). A lighter field inside a darker outline at a
 * hard radius is nonetheless what makes the eye resolve a SHAPE, so the frame
 * cost twice: the space, and the brightest pixel on the row having no
 * information in it. A2 deletes it for every phase but the last.
 *
 * These are the values, and they are asserted as values because they are the
 * spec: the pixels are the deliverable here, not an implementation detail of one.
 */
describe('A2 — no container for four days, and the fade carries the clock', () => {
  const TILE = ruleBody(CHIP_CSS, '.chatchip[data-shape="tile"]');

  it('the tile paints NOTHING — no fill, no hairline, and nothing to clip', () => {
    // A transparent border and not a deleted one: the box must not resize when
    // the outline arrives on the last day, or the glyph jumps 1px as it steps.
    expect(decl(TILE, 'border')).toBe('1px solid transparent');
    expect(TILE).not.toMatch(/(?:^|;)\s*background(?:-color)?:/);
    // `overflow: hidden` existed only to clip the descending fill to the tile's
    // corners. With no fill it is a clip waiting to cut a glyph that now
    // deliberately fills more of its box than the box has.
    expect(TILE).not.toMatch(/overflow:/);
  });

  it('has no descending FILL anywhere in it — the element is gone, not hidden', () => {
    expect(bare(CHIP_CSS)).not.toContain('chatchip-fill');
  });

  it('gives the glyph the space the frame was eating: 20px, stepping to 18px', () => {
    // 2× the area of the shipped 14px, on the row's own surface. The step to 18
    // happens ONCE, on the last day, so the glyph lands INSIDE the 24px outline
    // instead of wearing it snugly — the one thing worth taking from A3, and it
    // costs nothing at a step that already changes everything else about the mark.
    const base = ruleBody(CHIP_CSS, '.chatchip');
    expect(decl(base, '--chatchip-glyph')).toBe('20px');
    expect(decl(base, '--chatchip-glyph-last')).toBe('18px');
    // A card is a row in a different container, so it must not drift from it.
    const card = ruleBody(CHIP_CSS, '.chatchip[data-density="card"]');
    expect(decl(card, '--chatchip-glyph')).toBe('20px');
    expect(decl(card, '--chatchip-glyph-last')).toBe('18px');
  });

  it('the two middle rungs are the THEME’s fades, with the drain riding along', () => {
    // Opacity CARRIES the clock (it has a fixed zero); the grayscale drain rides
    // along on a second, independent channel, which is why the ladder reads
    // decisively across a luminance range of barely 2×. The alphas are theme
    // tokens because an emoji composited at α over a LIGHT ground loses contrast
    // faster than over a dark one — see styles.css.
    const one = ruleBody(CHIP_CSS, '.chatchip[data-step="1"] .chatchip-glyph');
    const two = ruleBody(CHIP_CSS, '.chatchip[data-step="2"] .chatchip-glyph');
    expect(decl(one, 'opacity')).toBe('var(--fade-1)');
    expect(decl(one, 'filter')).toBe('grayscale(50%)');
    expect(decl(two, 'opacity')).toBe('var(--fade-2)');
    expect(decl(two, 'filter')).toBe('grayscale(85%)');
  });

  it('has exactly TWO fade rungs — the fresh end needs none and there is no third', () => {
    // The fresh end is 1.00 on every theme (the measured light/dark gap there is
    // 1.00 vs 0.95, which is not a step), so it carries no rule at all.
    //
    // AND THERE IS NO STEP 3. `last_day` is read before the quantisation
    // (ChatChip.tsx), so the ladder is fresh / −1d / −2d / last: a rule for a
    // third fade would be a rule for a state the component cannot produce. Two
    // reviews reached for that as a bug; it is the shape of the design.
    const rungs = [...bare(CHIP_CSS).matchAll(/\[data-step="(\d)"\]/g)].map((m) => m[1]);
    expect([...new Set(rungs)].sort()).toEqual(['1', '2']);
  });

  it('the outline arrives DOTTED, once, and takes the glyph down with it', () => {
    // The fade has already made the mark soft; a dashed box is the hardest edge
    // left on the row, and dotted reads as dissolving rather than cut out.
    const frame = ruleBody(
      CHIP_CSS,
      '.chatchip[data-phase="last-day"][data-shape="tile"],.chatchip[data-phase="done"][data-shape="tile"]',
    );
    expect(decl(frame, 'border-style')).toBe('dotted');
    expect(frame).not.toMatch(/dashed/);
    const ghost = ruleBody(
      CHIP_CSS,
      '.chatchip[data-phase="last-day"] .chatchip-glyph,.chatchip[data-phase="done"] .chatchip-glyph',
    );
    expect(decl(ghost, 'font-size')).toBe('var(--chatchip-glyph-last)');
    expect(decl(ghost, 'opacity')).toBe('0.34');
    expect(decl(ghost, 'filter')).toBe('grayscale(100%)');
  });

  it('animates the fade, or a chat that is talked to snaps back instead of returning', () => {
    const glyph = ruleBody(CHIP_CSS, '.chatchip-glyph');
    const t = decl(glyph, 'transition') ?? '';
    for (const prop of ['opacity', 'filter', 'font-size']) expect(t).toContain(prop);
    // …and a user who asked for no motion gets the new state immediately. The
    // rule was already there for `filter`; opacity has to be inside it too.
    const still = ruleBody(CHIP_CSS, '.chatchip[data-shape="tile"],.chatchip-glyph,.chatchip-dot');
    expect(decl(still, 'transition')).toBe('none');
  });

  /**
   * CHIP DENSITY — 16px, inline in running text, and the one density A2 was not
   * specified for.
   *
   * It works, and the reason is that the mention PILL is already the container:
   * a tile inside it was a container inside a container, and at 16px it was the
   * one that had no room for either job. What must not move is the BOX — the
   * pill hangs off its own text's baseline with the chip opted out of baseline
   * alignment (ChatMentionPicker.css), so a 16px box in a ~21px line box is
   * what keeps a mention from rippling the paragraph around it. The glyph inside
   * it grows; the box does not.
   */
  it('scales to the 16px chip without touching the box the paragraph feels', () => {
    const inline = ruleBody(CHIP_CSS, '.chatchip[data-density="chip"]');
    expect(decl(inline, '--chatchip-size')).toBe('16px');
    // 13/16 and 12/16 are 20/24 and 18/24 — the same two ratios, so the drawing
    // is the row's at a smaller scale rather than a second set of numbers.
    expect(decl(inline, '--chatchip-glyph')).toBe('13px');
    expect(decl(inline, '--chatchip-glyph-last')).toBe('12px');
  });
});

/**
 * THE FADE LADDER RE-STEPS PER THEME, and this is the measurement behind it.
 *
 * An emoji composited at α over a LIGHT ground loses contrast faster than the
 * same α over a dark one, because the glyph's own luminance sits nearer the
 * light surface. Against a mid-grey glyph (the drain has taken the hue by these
 * steps), measured: 0.70 gives 2.23:1 on alucard's #f0edf7 and 2.49:1 on
 * dracula's #282a36; 0.46 gives 1.65 and 1.82. One ladder would leave the dark
 * themes a step brighter at exactly the end where the rungs are already
 * compressed — the whole visible ladder spans 3.42 → 1.65, barely 2×.
 *
 * So: the light themes carry .70/.46 and the dark ones .61/.39, and which a
 * theme is is read off its OWN --bg here rather than from a list, so a seventh
 * theme cannot quietly inherit the wrong end of the measurement.
 */
describe('every theme steps the fade to its own surface', () => {
  // Written with the leading zero, like every other alpha in these sheets.
  const LIGHT: [string, string] = ['0.7', '0.46'];
  const DARK: [string, string] = ['0.61', '0.39'];
  /** WCAG relative luminance of a #rrggbb, enough to say light from dark. */
  const luminance = (hex: string): number => {
    const ch = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const themes = [...bare(STYLES).matchAll(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)].map(
    (m) => ({ name: m[1] as string, body: m[2] as string }),
  );

  it('finds the themes at all (so the sweep below cannot pass vacuously)', () => {
    expect(themes.length).toBeGreaterThanOrEqual(6);
  });

  it.each(themes.map((t) => t.name))('%s steps both rungs to its own ground', (name) => {
    const body = themes.find((t) => t.name === name)?.body ?? '';
    const bg = body.match(/--bg:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(bg).toBeTruthy();
    const [one, two] = luminance(bg as string) > 0.5 ? LIGHT : DARK;
    expect(decl(body.replace(/\s+/g, ' '), '--fade-1')).toBe(one);
    expect(decl(body.replace(/\s+/g, ' '), '--fade-2')).toBe(two);
  });

  it(':root carries the DARK step, as the floor', () => {
    // Every other token in that block is the dark-surface step with the light
    // themes re-stepping below (--status-*, --clock-base), and the app's own
    // fallback surface is near-black. The light pair there would hand the two
    // dark themes that do not re-declare it a ladder tuned for cream.
    const root = bare(STYLES).match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(decl(root.replace(/\s+/g, ' '), '--fade-1')).toBe(DARK[0]);
    expect(decl(root.replace(/\s+/g, ' '), '--fade-2')).toBe(DARK[1]);
  });

  it('declares them nowhere else — the chip must not carry a fallback of its own', () => {
    // A `--fade-1` on .chatchip would resolve against the chip and inherit down
    // as a finished number, which is the exact trap --clock was moved OFF :root
    // to avoid, arriving from the other direction.
    expect(bare(CHIP_CSS)).not.toMatch(/--fade-[12]:/);
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
      // Tiles: fresh, BOTH fade rungs, last day, done, pinned. Every rung has
      // to be here by name — the ladder is two rules now, and a sweep that drew
      // only one of them would let the other rot unseen.
      renderToStaticMarkup(createElement(ChatChip, { density: 'row', chat: clock(0) })),
      renderToStaticMarkup(createElement(ChatChip, { density: 'row', chat: clock(1) })),
      renderToStaticMarkup(createElement(ChatChip, { density: 'row', chat: clock(2) })),
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
    // The clock itself, which is now two rules and nothing else.
    expect(selectors).toContain('.chatchip[data-step="1"] .chatchip-glyph');
    expect(selectors).toContain('.chatchip[data-step="2"] .chatchip-glyph');
  });

  it.each(selectors)('%s', (selector) => {
    const box = drawEverything();
    // `:not(:empty)`-style functional pseudos would need a live layout; this
    // sheet has none, so querySelectorAll is the engine's own answer.
    expect(box.querySelectorAll(selector).length).toBeGreaterThan(0);
  });
});
