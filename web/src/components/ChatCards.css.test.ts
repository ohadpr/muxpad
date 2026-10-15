import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE LEADER IS THE ONLY THING LEFT SAYING HOW CURRENT A CARD IS.
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

describe('the dotted leader', () => {
  it('is a real element, not a pseudo nobody can measure', () => {
    // Measured on the live app: getComputedStyle(el, '::before') reported the
    // same colour for --card-fresh 1, 0.5 and 0 AND for the stale class,
    // lagging a read behind. A gauge that cannot be read is a gauge that stops
    // working quietly — which is the exact failure it exists to surface.
    expect(rule('.chat-card-leader')).not.toBeNull();
    expect(css).not.toContain('.chat-card::before');
  });

  it('varies with --card-fresh rather than being a fixed colour', () => {
    const r = rule('.chat-card-leader') ?? '';
    expect(r).toContain('--card-fresh');
    // The fallback matters as much as the variable: a card with no declared
    // cadence must sit at full strength, not at zero.
    expect(r).toMatch(/var\(--card-fresh,\s*1\)/);
  });

  it('still overrides to the overdue colour, which is not a fade', () => {
    // Stale is a different claim from "getting old" and must not be reachable
    // by the gradient — a writer that stopped is a state, not a point on a ramp.
    expect(rule('.chat-card.-stale .chat-card-leader')).toContain('--status-working');
  });

  it('takes the row\u2019s slack, so the age needs no margin hack', () => {
    // The leader grows into the gap; the value is sized by its content and the
    // age sits at the end. That is what makes the dots a LEADER rather than
    // decoration floating in a space something else created.
    expect(rule('.chat-card-leader')).toMatch(/flex:\s*1 1 auto/);
    expect(rule('.chat-card-value')).toMatch(/flex:\s*0 1 auto/);
    expect(rule('.chat-card-age')).not.toContain('margin-left: auto');
  });

  it('feeds — the dots drift toward the age', () => {
    // The one piece of motion on a surface whose job is to sit still, and what
    // makes the card read as live rather than pasted. One 5px step per cycle:
    // the dot pitch, so it loops seamlessly rather than jumping.
    expect(rule('.chat-card-leader')).toMatch(/animation:\s*chat-card-feed/);
    const kf = rule('@keyframes chat-card-feed') ?? '';
    expect(kf).toContain('background-position: 5px center');
    expect(rule('.chat-card-leader')).toMatch(/background-size:\s*5px 5px/);
  });

  it('stops feeding under reduced motion', () => {
    const i = css.indexOf('@media (prefers-reduced-motion');
    expect(i).toBeGreaterThan(-1);
    expect(css.slice(i, i + 160)).toContain('.chat-card-leader');
  });
});

describe('a card has to look like a card', () => {
  /**
   * Two wrong answers before this one, both measured.
   *
   * First: `--bg-elev` tinted 7% warm, separating from the chat by TEMPERATURE
   * alone — ΔL* 0.2 in alucard, ΔE 1.5 in acme. Two surfaces at the same
   * lightness read as one.
   *
   * Second: the chat background mixed toward the FOREGROUND. That separates
   * honestly, and it is grey: a warm-grey panel in an app made of purple,
   * which got the accurate review "the colors are just ugly".
   *
   * So it separates by lightness, in the app's OWN hue. Across all six themes:
   * ΔL* 4.4-5.9, ΔE 5.9-9.3, value text no worse than 5.17:1.
   */
  it('is derived from the chat BACKGROUND, not from elev', () => {
    // In dracula, --bg-elev is DARKER than --bg: an elev-based card sits at
    // ΔL* 1.1 there no matter how much tint goes into it.
    const r = rule('.chat-card') ?? '';
    expect(r).toContain('--chat-bg');
    expect(r).not.toMatch(/background:[^;]*--chat-elev/);
  });

  it('is tinted with the ACCENT — the app\'s own colour, not a grey', () => {
    expect(rule('.chat-card')).toMatch(/var\(--chat-accent\)\s+\d+%,\s*var\(--chat-bg\)/);
  });

  it('has no warm tint left in it at all', () => {
    // The "warm paper" idea is what produced both of the ugly versions. The
    // overdue edge still uses --status-working; the SURFACE must not.
    const r = rule('.chat-card') ?? '';
    expect(r).not.toContain('--status-working');
    expect(rule('.chat-card.-stale')).toContain('--status-working');
  });

  it('has a visible edge', () => {
    expect(rule('.chat-card')).toMatch(/border:\s*1px solid/);
  });
});

describe('the full-width preview', () => {
  it('takes a whole line of the wrapped row', () => {
    // `flex: 1 0 100%` is the entire mechanism: a line of its own inside the
    // same button, so the content is bounded by the CARD rather than by what
    // the name and the age left over.
    expect(rule('.chat-card-preview')).toMatch(/flex:\s*1 0 100%/);
    expect(rule('.chat-card-row')).toContain('flex-wrap: wrap');
  });

  it('is ONE line compact — a card is a glance, not a paragraph', () => {
    // Four lines made a slab taller than the message above it; two was still a
    // paragraph. "Make cards 1 line of text when compact." The rest is one tap
    // away, which is what the card opening is for.
    expect(rule('.chat-card-preview')).toMatch(/max-height:\s*calc\(1 \*/);
  });

  it('fades sideways, because a downward fade at one line dims the only line', () => {
    expect(rule('.chat-card-preview.-clipped')).toContain('to right');
  });

  it('flattens the log\'s paragraph margins, which are what made it a slab', () => {
    // .chat-md p carries 0.6em top AND bottom, and a markdown card written with
    // blank lines arrives as a column of paragraphs with 16px of air between
    // them. The old rule only reached the WRAPPER div, so it did nothing.
    const i = css.indexOf('.chat-card-preview .chat-md');
    expect(i).toBeGreaterThan(-1);
    expect(css.slice(i, css.indexOf('}', i))).toContain('margin: 0');
  });

  it('fades ONLY when something is actually cut off', () => {
    // An unconditional fade dims the last line of a card that fits perfectly,
    // which reads as the card being broken rather than as "there is more".
    expect(rule('.chat-card-preview')).not.toContain('mask-image');
    expect(rule('.chat-card-preview.-clipped')).toContain('mask-image');
  });

  it('is not touched by the inline override that keeps a one-line card on one line', () => {
    // `display: inline` run over a preview would weld every block together —
    // the "did something mess up newlines?" bug wearing a different hat. The
    // override is scoped to the VALUE, which is the one-line slot.
    expect(rule('.chat-card-value > *')).toContain('display: inline');
    expect(css).not.toContain('.chat-card-preview > * {');
  });
});
