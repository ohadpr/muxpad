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

const px = (value: string | null) =>
  Number.parseFloat(value ?? '') * (value?.endsWith('rem') ? 16 : 1);

describe('the status strip is a line, not a second object', () => {
  it('draws no border of its own', () => {
    // A border around the strip is what made it read as a second object stacked
    // on the composer, and a third of the bar's height went on drawing it.
    expect(decl('.chat-status-bar', 'border')).toBeNull();
  });

  it('paints no background of its own', () => {
    expect(decl('.chat-status-bar', 'background')).toBeNull();
  });

  it("shares the pill's tool row instead of owning a row of its own", () => {
    // It has cost three different things. A full-width row under the pill:
    // one line plus a 16px gap, permanently, "which reduces the amount of
    // content we can show in the window". Then nothing at all, as a chip hung
    // off the pill's top edge by `position: absolute` — which painted over the
    // last line of the transcript instead.
    //
    // Now it is the right-hand end of a row INSIDE the pill, shared with the
    // `+`. One row for two things that each used to want their own, no second
    // surface, and nothing covered.
    expect(decl('.chat-status-bar', 'position')).toBeNull();
    expect(decl('.chat-status-bar', 'margin')).toBe('0');
    // The row is a one-line floor and nothing more — this is the budget.
    const row = px(decl('.chat-composer-tools', 'min-height'));
    expect(row).toBeGreaterThan(0);
    expect(row).toBeLessThanOrEqual(32);
  });
});

describe('a one-line composer is a known height', () => {
  it('fixes the line at 40px, and says the same thing twice', () => {
    // height and min-height must agree: JS grows `height` for multi-line from
    // whatever this is, so a disagreement makes the resting height a guess.
    expect(decl('.chat-input', 'height')).toBe('2.5rem');
    expect(decl('.chat-input', 'min-height')).toBe('2.5rem');
  });

  it('pads to exactly that, so the number is not a coincidence', () => {
    // 22px line + 2×9 padding = 40. The previous rule padded 13px to reach 48
    // while its comment claimed 36 — the arithmetic is the check that the
    // comment and the code still describe the same bar.
    const padding = decl('.chat-input', 'padding');
    const line = decl('.chat-input', 'line-height');
    const top = px((padding ?? '').split(/\s+/)[0] ?? null);
    const linePx = Number.parseFloat(line ?? '') * (line?.endsWith('rem') ? 16 : 1);
    expect(line).toBe('1.375rem');
    expect(linePx + top * 2).toBe(40);
  });
});

/**
 * THE PILL SPENDS ONE INSET, AND EVERYTHING INSIDE LINES UP ON IT.
 *
 * "Margin for message being typed is too tight on left and potentially top,
 * button the same too close to top and potentially too close to the right."
 * Three symptoms, one cause: the padding was being spent unevenly by what sat
 * inside it. The text had the pill's 10px and nothing of its own; the send
 * circle is 36px against a 40px line, so a 4px top gave it 6px of air against
 * 10px at its right; and the tool row's buttons carry 8px of their own, so
 * their icons sat 8px right of the text above them.
 */
describe('the composer pill is spaced from one number', () => {
  const sideOf = (sel: string, re: RegExp): number => {
    const rest = css.slice(css.indexOf(`${sel} {`));
    const body = rest.slice(0, rest.indexOf('}'));
    return Number(re.exec(body)?.[1] ?? Number.NaN);
  };

  it('insets the same amount on both sides', () => {
    const pad = (decl('.chat-composer', 'padding') ?? '').split(/\s+/);
    expect(pad).toHaveLength(2);
    expect(Number.parseFloat(pad[1] ?? '')).toBeGreaterThanOrEqual(12);
  });

  it('gives the send circle the air its ink needs at the top', () => {
    // The circle is 36px in a 40px row, so it starts 2px in. With a 4px pill
    // padding that was 6px of air above against 10px beside — which reads as
    // "too close to the top" because it is.
    const pad = (decl('.chat-composer', 'padding') ?? '').split(/\s+/);
    const top = Number.parseFloat(pad[0] ?? '');
    const side = Number.parseFloat(pad[1] ?? '');
    expect(top + 2).toBeGreaterThanOrEqual(side - 2);
  });

  it('starts the text at the inset, counting both paddings', () => {
    const side = sideOf('.chat-composer', /padding:\s*\d+px (\d+)px/);
    const input = sideOf('.chat-input', /padding:\s*[\d.]+rem (\d+)px/);
    expect(side + input).toBe(16);
  });
});
