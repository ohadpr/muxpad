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

describe('one shape, whatever is in it', () => {
  /**
   * The card was assembled three ways — value inline in a row, a full-width
   * preview under a row, a row above a frame — and the seams showed: the name
   * moved between inline, header and absent depending on how many cards there
   * were and whether one was open, and an html card's row toggled a state that
   * changed nothing on screen. "Sometimes it's above, sometimes the line is
   * below… clicking the line changes it a bit but doesn't expand."
   */
  it('draws no name at all — the value is what you came to read', () => {
    expect(rule('.chat-card-name')).toBeNull();
    expect(css).not.toContain('.chat-card-name');
  });

  it('has one collapsed line, and it is one LINE', () => {
    const line = rule('.chat-card-line') ?? '';
    expect(line).toContain('white-space: nowrap');
    expect(line).toContain('text-overflow: ellipsis');
  });

  it('flattens a markdown card onto that line rather than laying it out', () => {
    // Blocks rendered into a 19px box lose everything but the first line, and
    // silently — the card looks fine and is missing its content.
    expect(rule('.chat-card-line > *')).toContain('display: inline');
    // AND THE BLOCKS INSIDE THE WRAPPER. `Markdown` emits a <div class="chat-md">
    // with <p> children, so the rule above only reaches the wrapper — the same
    // miss that shipped once already on the preview this replaced. Measured in
    // the live app: a two-paragraph card rendering 59px tall on a "one line".
    const i = css.indexOf('.chat-card-line .chat-md');
    expect(i).toBeGreaterThan(-1);
    expect(css.slice(i, css.indexOf('}', i))).toContain('display: inline');
  });

  it('makes the WHOLE card the target, not a row beside the body', () => {
    // The row-as-button existed because a <button> may only hold phrasing
    // content and markdown emits <p>. That split is what let the control and
    // the body disagree about what a click does.
    expect(rule('.chat-card.-togglable')).toContain('cursor: pointer');
    expect(rule('.chat-card-row')).toBeNull();
    expect(rule('.chat-card.-togglable:focus-visible')).toContain('box-shadow');
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

describe('an html card renders whole', () => {
  it('reserves the tail’s width so the clock never lands on the author’s corner', () => {
    expect(rule('.chat-card-body.-flush')).toContain('padding');
  });

  it('keeps no padding of its own otherwise — the frame styles itself', () => {
    const flush = rule('.chat-card-body.-flush') ?? '';
    expect(flush).toMatch(/padding:\s*0 \d+px 0 0/);
  });
});
