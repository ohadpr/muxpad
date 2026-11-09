import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKING_VARIANTS } from '../lib/working-variant';

/**
 * THE HOUSE RULES EVERY INDICATOR HAS TO OBEY.
 *
 * The one these replaced was a 120px moiré field, shipped on the strength of
 * looking superb AT 3× ZOOM ON A DARK BACKGROUND. It is used on a light theme at
 * 1×, where its 0.8px hatching aliases into grey mush and it owns a whole line.
 * "This just takes up a full line and is meh."
 *
 * So the rules are pinned rather than remembered — with ten of these, a bad one
 * is now ten times easier to add.
 */
const css = readFileSync(join(__dirname, 'ChatWorking.css'), 'utf8');

describe('every working indicator', () => {
  it('has a rule at all — ten variants, ten implementations', () => {
    for (const v of WORKING_VARIANTS) {
      expect(css, `missing styles for -${v}`).toContain(`.chat-typing.-${v}`);
    }
  });

  it('is small enough not to own a line', () => {
    // Widths are declared in px or ch; anything over 46px is the old mistake.
    for (const m of css.matchAll(/\.chat-typing\.-(\w+)\s*\{([^}]*)\}/g)) {
      const px = Number(m[2]?.match(/width:\s*(\d+)px/)?.[1] ?? 0);
      expect(px, `${m[1]} is ${px}px wide`).toBeLessThanOrEqual(46);
    }
    expect(css).toMatch(/\.chat-typing\s*\{[^}]*height:\s*18px/);
  });

  it('animates nothing that costs layout', () => {
    // Several panes can be working at once. `margin-top` in the pong ball's
    // vertical bounce is the one exception and it is 3px on an absolutely
    // positioned element, so it reflows nothing outside itself.
    for (const m of css.matchAll(/@keyframes ([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
      const [, name, body] = m;
      if (name === 'ct-ball-y') continue;
      expect(body, `${name} animates a layout property`).not.toMatch(
        /\n\s*(width|height|padding|font-size|left|right|top|bottom):/,
      );
    }
  });

  it('cuts between sprite frames instead of crossfading', () => {
    // A two-frame sprite that fades shows the arms in both places at once,
    // which is the single most common way to make pixel art look wrong.
    for (const sel of ['.chat-typing.-invader .f1', '.chat-typing.-prompt .cur']) {
      const i = css.indexOf(sel);
      expect(i).toBeGreaterThan(-1);
      expect(css.slice(i, css.indexOf('}', i))).toContain('steps(1)');
    }
  });

  it('windows sprite strips in `ch`, not px', () => {
    // 1ch IS one glyph in a monospace face, so the window cannot drift out of
    // phase with the strip however the font renders. A px window can and does.
    for (const v of ['braille', 'ascii', 'tetris']) {
      const i = css.indexOf(`.chat-typing.-${v} {`);
      expect(css.slice(i, css.indexOf('}', i)), v).toMatch(/width:\s*1ch/);
    }
    expect(css).toMatch(/@keyframes ct-strip8[\s\S]*?translateX\(-8ch\)/);
    expect(css).toMatch(/@keyframes ct-strip4[\s\S]*?translateX\(-4ch\)/);
  });

  it('counts in real binary — each bit at half the rate of the last', () => {
    // Not a stylisation of a counter; it IS one. Eight steps(2) animations with
    // doubling durations produce a genuine count up with no logic anywhere.
    const d = [...Array(8).keys()].map((b) => {
      const i = css.indexOf(`.chat-typing.-binary .b${b} {`);
      return Number(css.slice(i, css.indexOf('}', i)).match(/ct-bit ([\d.]+)s/)?.[1]);
    });
    for (let b = 1; b < 8; b++) {
      const cur = d[b] as number;
      const prev = d[b - 1] as number;
      expect(Number.isFinite(cur) && Number.isFinite(prev), `bit ${b} has no duration`).toBe(true);
      expect(cur / prev, `bit ${b}`).toBeCloseTo(2, 2);
    }
  });

  it('holds a static frame under reduced motion', () => {
    // The @media rule, not the first mention of the phrase — which is in the
    // header comment, and made this assert against prose.
    const i = css.indexOf('@media (prefers-reduced-motion');
    expect(i).toBeGreaterThan(-1);
    const block = css.slice(i);
    expect(block).toContain('animation: none');
    expect(block).not.toContain('display: none');
  });
});

/**
 * THE HINT STAYS ONE LINE.
 *
 * The owner asked for a clue about what is happening during a long tool
 * stretch, explicitly NOT as "a log where five of these would cause the whole
 * view to push up". That promise is kept in CSS: if this ever wraps, the
 * indicator grows and the conversation reflows on every tool call, which is
 * precisely the thing it was built to avoid.
 */
describe('the working hint cannot become a paragraph', () => {
  const css = readFileSync(join(import.meta.dirname, 'ChatPane.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    expect(i, `${sel} has no rule`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  };

  it('clamps to one line, with an ellipsis', () => {
    const r = rule('.chat-working-hint');
    expect(r).toMatch(/white-space:\s*nowrap/);
    expect(r).toMatch(/text-overflow:\s*ellipsis/);
    expect(r).toMatch(/overflow:\s*hidden/);
  });

  it('is allowed to shrink — without this the ellipsis never appears', () => {
    // A flex item will not go below its content width unless told to, so the
    // row grows instead of truncating. Both the item and its container.
    expect(rule('.chat-working-hint')).toMatch(/min-width:\s*0/);
    expect(rule('.chat-working')).toMatch(/min-width:\s*0/);
  });

  it('gives way before the tool name does', () => {
    // The tool name is the one thing only this row can say; the hint is the
    // nicety beside it.
    expect(rule('.chat-working-label')).toMatch(/flex:\s*0 0 auto/);
    expect(rule('.chat-working-hint')).toMatch(/flex:\s*0 1 auto/);
  });
});
