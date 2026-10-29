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

/**
 * A fenced block wraps — and it is no longer the media query that says so.
 *
 * It used to be: `.chat-md pre code { white-space: pre-wrap }` inside the
 * phone breakpoint, because a horizontal drag inside a vertically scrolling
 * log fights the scroll it is nested in and nothing on screen says there is
 * anything to the right. The measured case was an email in a fence: 75
 * characters in a 393px viewport, every line cut mid-sentence.
 *
 * Every block is wrapped by default now, on every surface (CopyablePre), so
 * the phone gets that for free. The override had to GO rather than be left
 * as a belt: it is unconditional, so it beat the unwrap toggle on a phone and
 * the control did nothing when pressed.
 */
describe('a fenced block', () => {
  const i = FLAT.indexOf('@media (max-width: 720px)');
  const block = FLAT.slice(i, FLAT.indexOf('\n}\n', i));

  it('is not force-wrapped by the phone breakpoint any more', () => {
    // Unconditional, so it outranked `pre[data-wrap]` being absent — which is
    // how "show the original line breaks" became a button that did nothing on
    // the one surface where this rule applied.
    expect(block).not.toMatch(/\.chat-md pre code\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  it('wraps by default, from the component, on every surface', () => {
    const copyable = readFileSync(join(import.meta.dirname, 'CopyablePre.tsx'), 'utf8');
    expect(copyable).toMatch(/const \[wrap, setWrap\] = useState\(true\)/);
    const css = readFileSync(join(import.meta.dirname, 'CopyablePre.css'), 'utf8');
    expect(css).toMatch(/pre\[data-wrap="true"\] code/);
  });

  it('still has somewhere to scroll when a reader unwraps it', () => {
    // Wrapped text loses the shape of its indentation; clipped text loses the
    // words. The default pays the smaller cost and the toggle buys the other
    // back — which needs the desktop's scroller to still be there.
    const desktop = FLAT.slice(0, i);
    expect(desktop).toMatch(/\.chat-md pre\s*\{[^}]*overflow-x:\s*auto/);
    expect(desktop).toMatch(/\.chat-md pre code\s*\{[^}]*white-space:\s*pre;/);
  });
});

/**
 * AN INLINE BOX IN RUNNING TEXT HAS TO SURVIVE BEING BROKEN.
 *
 * A span of code inside a sentence is a box: padding, a border, a radius. By
 * default a browser SPLITS that decoration across a line break, so the first
 * fragment ends with an open right edge and the second starts with an open
 * left one — two halves of a rounded rectangle on different lines, neither of
 * them closed. `kill: operation not permitted` in the middle of a sentence
 * showed it exactly.
 */
describe('inline code that wraps', () => {
  const rule = (selector: string): string => {
    const i = FLAT.indexOf(`${selector} {`);
    expect(i, `${selector} not found`).toBeGreaterThan(-1);
    return FLAT.slice(i, FLAT.indexOf('}', i));
  };

  it('draws a complete box on every fragment', () => {
    const body = rule('.chat-md :not(pre) > code');
    expect(body).toMatch(/box-decoration-break:\s*clone/);
    // WebKit still ships this behind the prefix, and Safari is half the
    // devices this runs on.
    expect(body).toMatch(/-webkit-box-decoration-break:\s*clone/);
  });

  it('is not taller than the line it sits in', () => {
    // Vertical padding plus a 1px border on a 0.86em face pushed the box past
    // the line box, so a wrapped fragment overlapped the line above it. The
    // paragraph's line-height is 1.62 — the box has to fit inside that.
    const body = rule('.chat-md :not(pre) > code');
    const top = Number.parseFloat(/padding:\s*([\d.]+)em/.exec(body)?.[1] ?? 'NaN');
    const size = Number.parseFloat(/font-size:\s*([\d.]+)em/.exec(body)?.[1] ?? 'NaN');
    // (2 × padding + 2 × 1px border) in em of the PARAGRAPH, against the 0.62
    // em of leading a 1.62 line-height gives it.
    expect(top * 2 * size + 2 / 16).toBeLessThan(0.62);
  });

  it('is matched by the search highlight, which breaks the same way', () => {
    // `.chat-hit` got there first — a match that wraps must be filled and
    // ruled on both fragments or the second half loses its background.
    expect(rule('.chat-hit')).toMatch(/box-decoration-break:\s*clone/);
  });
});
