import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * HOW TALL THE BOTTOM BAR IS, and why these particular declarations.
 *
 * Measured at 390px before this: 119px, of which
 *
 *   · 37px was the status strip — its own border, its own background, and a
 *     10px gap under it. A third of the whole bar for a line you read and
 *     almost never press.
 *   · 48px was a one-line input whose own comment said it should be 36px to sit
 *     level with the round buttons beside it. The number had been changed and
 *     the reasoning left behind, which is how a bar gets tall without anybody
 *     deciding it should.
 *
 * The strip stopped being a second object and the input became 40px.
 * 119px → 85px.
 *
 * This is a CSS-contract test rather than a screenshot because the thing that
 * made the strip a separate object is a set of DECLARATIONS — a border, a
 * background, a margin. A picture shows it looks fine; only the rule says
 * whether the next person will reintroduce them by habit.
 *
 * ─── UPDATE: the strip is back OUTSIDE the pill, and the budget survived ───
 * Sharing the pill's surface paid the 37px back and over-corrected: a line about
 * the session became chrome inside the thing you type in ("it's all too tight
 * there"), and because it sat above the input inside a bottom-anchored pill, the
 * one time it wrapped it shoved the composer down. It is a sibling above the
 * pill again — but WITHOUT the border, the background and the 10px gap that made
 * the original expensive. That distinction is the whole point of this file, so
 * what it asserts is the diet, not the address: the strip may live where it
 * likes as long as it costs one line of text and one small gap. See
 * ChatPane.statusline.test.tsx for the placement and the one-line construction.
 */

const css = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

/** Prose about a declaration is not a declaration. */
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector: string): string {
  const rules = [...bare(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.find(
    (m) =>
      (m[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .join(',') === selector,
  );
  if (!hit) throw new Error(`no rule for ${selector}`);
  return hit[2] ?? '';
}

const decl = (selector: string, prop: string): string | null => {
  const body = ruleBody(selector);
  // The LAST wins, as the cascade decides it within one rule.
  const all = [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].filter(
    (m) => (m[1] ?? '').trim() === prop,
  );
  const hit = all[all.length - 1];
  return hit ? (hit[2] ?? '').trim() : null;
};

describe('the status strip is a line, not a second object', () => {
  it('draws no border of its own', () => {
    // A border around the strip is what made it read as a second object stacked
    // on the composer, and a third of the bar's height went on drawing it.
    expect(decl('.chat-status-bar', 'border')).toBeNull();
  });

  it('paints no background of its own', () => {
    expect(decl('.chat-status-bar', 'background')).toBeNull();
  });

  it('costs one line and one gap \u2014 the whole budget, wherever it sits', () => {
    // Two things could hold the strip off the text below — its own bottom
    // margin and the composer's row gap — and having both is how a bar drifts
    // taller one nudge at a time.
    //
    // Outside the pill again, the strip's OWN bottom margin is the only thing
    // that can hold it off the pill — so what is asserted is that there is still
    // exactly one separation and it is no bigger than the row gap it replaces.
    const own = (decl('.chat-status-bar', 'margin') ?? '').split(/\s+/);
    const below = Number((own[2] ?? '').replace('px', ''));
    const pillGap = Number((decl('.chat-composer', 'gap') ?? '').replace('px', ''));
    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThanOrEqual(pillGap);
    // And the line is FIXED, not a value its content can grow — which is what
    // makes this a budget rather than a hope. See ChatPane.statusline.test.tsx.
    const h = Number((decl('.chat-status-bar', 'height') ?? '').replace('px', ''));
    expect(h + below).toBeLessThanOrEqual(24);
  });
});

describe('a one-line composer is a known height', () => {
  it('fixes the line at 40px, and says the same thing twice', () => {
    // height and min-height must agree: JS grows `height` for multi-line from
    // whatever this is, so a disagreement makes the resting height a guess.
    expect(decl('.chat-input', 'height')).toBe('40px');
    expect(decl('.chat-input', 'min-height')).toBe('40px');
  });

  it('pads to exactly that, so the number is not a coincidence', () => {
    // 22px line + 2×9 padding = 40. The previous rule padded 13px to reach 48
    // while its comment claimed 36 — the arithmetic is the check that the
    // comment and the code still describe the same bar.
    const padding = decl('.chat-input', 'padding');
    const line = decl('.chat-input', 'line-height');
    const top = Number((padding ?? '').split(/\s+/)[0]?.replace('px', ''));
    expect(Number((line ?? '').replace('px', '')) + top * 2).toBe(40);
  });
});
