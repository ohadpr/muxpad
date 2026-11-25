import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE RESULTS BELOW THE KEYBOARD HAVE TO BE REACHABLE.
 *
 * The old drop-down sheet capped itself by the VISUAL viewport, because the
 * layout viewport does not shrink when a software keyboard opens — iOS never
 * has, and Chrome has not since 108 (`interactive-widget: resizes-visual`).
 * Without that correction the scroller's content fits inside its full-screen
 * box, so there is NO OVERFLOW and the rows under the keyboard line cannot be
 * scrolled to at all. Measured on the sheet at 390×844 with a one-character
 * query: 5 of 12 results hidden, `scrollHeight === clientHeight`.
 *
 * Search then moved into the full-height list and that sizing was deleted with
 * the sheet, with nothing replacing it — found by review. These assertions are
 * the replacement, and they are about the WIRING because the geometry itself
 * only exists on a real phone.
 */
const css = readFileSync(join(__dirname, 'MobileNav.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(join(__dirname, 'MobileNav.tsx'), 'utf8').replace(
  /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
  '',
);

describe('the phone list’s search survives a software keyboard', () => {
  it('reserves the keyboard’s height under the results, restoring the overflow', () => {
    const rule = /\.mcl-search\s+\.cmdk-results\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(rule).toMatch(/padding-bottom:\s*var\(--chat-keyboard-inset,\s*0px\)/);
  });

  it('tracks the visual viewport on the list itself, so the variable has a value', () => {
    // Capping or padding by a variable nobody writes is the same as not doing
    // it — which is precisely how the sheet's correction was lost.
    expect(tsx).toMatch(/trackKeyboardInset\(/);
    expect(tsx).toMatch(/viewport:\s*window\.visualViewport\s*\?\?\s*null/);
    expect(tsx).toMatch(/className="mobile-chat-list"\s+ref=\{listRef\}/);
  });

  it('stops tracking when the list is hidden, rather than latching a value', () => {
    const effect = tsx.slice(tsx.indexOf('const el = listRef.current;'));
    expect(effect.slice(0, 200)).toMatch(/if \(!visible \|\| !el\) return;/);
    // trackKeyboardInset removes the property on dispose; returning it is what
    // makes that happen when `visible` goes false.
    expect(effect.slice(0, 260)).toMatch(/return trackKeyboardInset/);
  });
});
