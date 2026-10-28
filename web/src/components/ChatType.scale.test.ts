import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CONVERSATION KEEPS ITS PROPORTIONS ON A PHONE.
 *
 * `.chat-pane` steps its prose up on a narrow screen — 0.96875rem → 1.1125rem,
 * +15% — and anything inside the conversation that was sized in REM did not
 * come with it. Measured: code in a fence went from 0.82× the prose on a
 * desktop to 0.72× on a phone, so the block quietly shrank, relatively, in the
 * place it had the least room. Reported as "font sizes don't seem to be
 * calibrated on mobile… I suspect that for others as well" — and it was not a
 * theme at all: no theme that ships sets a font-size, so this was every one of
 * them.
 *
 * The fix is the rule the headings and inline code already followed: text that
 * belongs to the CONVERSATION is sized in `em`, so one declaration moves all
 * of it. Chrome around the conversation — chips, the tool row, the session
 * strip — stays in rem on purpose: it is UI, and it does not grow because the
 * prose did.
 */
const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');
const FLAT = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const sizeOf = (selector: string): string => {
  const i = FLAT.indexOf(`${selector} {`);
  expect(i, `${selector} not found`).toBeGreaterThan(-1);
  const body = FLAT.slice(i, FLAT.indexOf('}', i));
  return /font-size:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '';
};

describe('conversation text is sized relative to the pane', () => {
  it.each([
    ['.chat-md pre code'],
    ['.chat-modal-block'],
    ['.chat-diff'],
    ['.chat-thinking'],
    ['.chat-working-label'],
    ['.chat-md :not(pre) > code'],
    ['.chat-md h1'],
    ['.chat-md table'],
  ])('%s is em, not rem', (selector) => {
    expect(sizeOf(selector)).toMatch(/em$/);
  });

  it('holds the same ratios on both layouts, which is what em buys', () => {
    const pane = 0.96875;
    const mobile = 1.1125;
    const em = Number.parseFloat(sizeOf('.chat-md pre code'));
    // Desktop stays where it was to within a tenth of a pixel — this was a
    // re-expression, not a resize.
    expect(Math.abs(em * pane * 16 - 12.75)).toBeLessThan(0.1);
    // …and the phone now gets the same proportion rather than the same pixels.
    expect(em * mobile * 16).toBeGreaterThan(14);
  });

  it('keeps the composer field at 16px or more on a phone', () => {
    // iOS zooms the viewport when a focused input is under 16px, which on this
    // layout means the composer drags the whole pane with it.
    const i = FLAT.indexOf('@media (max-width: 720px)');
    const block = FLAT.slice(i, FLAT.indexOf('\n}\n', i));
    const input = /\.chat-input\s*\{[^}]*font-size:\s*([\d.]+)rem/.exec(block)?.[1];
    expect(Number(input) * 16).toBeGreaterThanOrEqual(16);
  });
});

describe('a fenced block on a phone', () => {
  const i = FLAT.indexOf('@media (max-width: 720px)');
  const block = FLAT.slice(i, FLAT.indexOf('\n}\n', i));

  it('wraps instead of clipping at the pane edge', () => {
    // A horizontal drag inside a vertically scrolling log fights the scroll it
    // is nested in, and nothing on screen says there is anything to the right.
    // The measured case was an email in a fence: 75-character lines in a 393px
    // viewport, every one cut mid-sentence.
    expect(block).toMatch(/\.chat-md pre code\s*\{[^}]*white-space:\s*pre-wrap/);
    expect(block).toMatch(/\.chat-md pre code\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('still scrolls on a desktop, where code keeps its indentation', () => {
    // Wrapped code loses the shape of its indentation; clipped code loses the
    // words. The phone pays the smaller of the two, and only the phone.
    expect(sizeOf('.chat-md pre code')).toBeTruthy();
    const desktop = FLAT.slice(0, i);
    expect(desktop).toMatch(/\.chat-md pre\s*\{[^}]*overflow-x:\s*auto/);
    expect(desktop).toMatch(/\.chat-md pre code\s*\{[^}]*white-space:\s*pre;/);
  });
});
