import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE AGE IS A TAIL IN THE CORNER, AND IT COSTS THE VALUE NOTHING.
 *
 * The property has outlived three mechanisms, which is why it is tested on its
 * own. It was `margin-left: auto` pushing the age to the edge across a gap;
 * then a dotted LEADER element that took the row's slack and carried freshness
 * in its dots; now it is out of the flow entirely, pinned to the card's
 * top-right — "I don't want the title and last updated to consume an entire
 * line… maybe add it as sort of a tail at the top right".
 *
 * What must not change: the age is never squeezed, never ellipsized, and never
 * lands on top of the value.
 */
const css = readFileSync(join(__dirname, 'ChatCards.css'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? null : css.slice(i, css.indexOf('\n}', i));
};
const decl = (body: string | null, prop: string) => {
  const m = new RegExp(`(?:^|;|\\n)\\s*${prop}:\\s*([^;]+)`).exec(body ?? '');
  return (m?.[1] ?? '').trim();
};

describe('the card age', () => {
  it('is out of the flow, in the corner', () => {
    const age = rule('.chat-card-age');
    expect(decl(age, 'position')).toBe('absolute');
    expect(decl(age, 'top')).toBeTruthy();
    expect(decl(age, 'right')).toBeTruthy();
  });

  it('takes no width from the value — it is not a column any more', () => {
    // The leader and the name were the other two things on that line, and both
    // are gone: a card is its value plus this.
    expect(rule('.chat-card-leader')).toBeNull();
    expect(rule('.chat-card-name')).toBeNull();
  });

  it('never lands ON the value — every content box reserves its width', () => {
    // Absolute positioning takes the tail out of the flow, so the clearance has
    // to be paid by the content or a long line runs underneath the clock.
    for (const sel of ['.chat-card-line', '.chat-card-body', '.chat-card-body.-flush']) {
      const padRight = Number.parseFloat(decl(rule(sel), 'padding').split(/\s+/)[1] ?? '0');
      expect({ sel, clears: padRight >= 40 }).toEqual({ sel, clears: true });
    }
  });

  it('does not swallow the click the card is one big target for', () => {
    expect(decl(rule('.chat-card-age'), 'pointer-events')).toBe('none');
  });

  it('goes warm when the writer stopped, and says so for a reader who cannot see it', () => {
    expect(rule('.chat-card-age.-stale')).toContain('--status-working');
    expect(rule('.chat-card-sr')).toBeTruthy();
  });
});
