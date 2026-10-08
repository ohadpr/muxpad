import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE RAIL IS THE ONLY THING LEFT SAYING HOW CURRENT A CARD IS.
 *
 * The compact row carries no timestamp — "NOW 10/8" cost the tail of the value
 * on a 430px phone, and a card is the current value by construction anyway. So
 * freshness moved into 2.5px of colour, and these pin the two properties that
 * make that honest: it has to actually VARY with the cadence, and it has to be
 * an element something can read.
 */
const css = readFileSync(join(__dirname, 'ChatCards.css'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? null : css.slice(i, css.indexOf('}', i));
};

describe('the freshness rail', () => {
  it('is a real element, not a pseudo nobody can measure', () => {
    // Measured on the live app: getComputedStyle(el, '::before') reported the
    // same colour for --card-fresh 1, 0.5 and 0 AND for the stale class,
    // lagging a read behind. A gauge that cannot be read is a gauge that stops
    // working quietly — which is the exact failure it exists to surface.
    expect(rule('.chat-card-rail')).not.toBeNull();
    expect(css).not.toContain('.chat-card::before');
  });

  it('varies with --card-fresh rather than being a fixed colour', () => {
    const r = rule('.chat-card-rail') ?? '';
    expect(r).toContain('--card-fresh');
    // The fallback matters as much as the variable: a card with no declared
    // cadence must sit at full strength, not at zero.
    expect(r).toMatch(/var\(--card-fresh,\s*1\)/);
  });

  it('still overrides to the overdue colour, which is not a fade', () => {
    // Stale is a different claim from "getting old" and must not be reachable
    // by the gradient — a writer that stopped is a state, not a point on a ramp.
    expect(rule('.chat-card.-stale .chat-card-rail')).toContain('--status-working');
  });

  it('costs no height at any content size', () => {
    // The whole bargain: the rail replaced a 34px header row by spending width.
    const r = rule('.chat-card-rail') ?? '';
    expect(r).toContain('position: absolute');
    expect(r).toMatch(/width:\s*2\.5px/);
  });
});
