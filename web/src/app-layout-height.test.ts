import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE STATUS BAR'S PADDING MUST NOT MAKE THE APP TALLER THAN THE SCREEN.
 *
 * `.app-layout` is `height: 100svh` with `padding-top: env(safe-area-inset-top)`.
 * Under the default content-box those ADD, so on a notched iPhone the layout
 * was one status bar taller than the viewport and the bottom tab bar fell off
 * the end of it — reported from a phone, in the list and in a chat.
 *
 * It was invisible until `apple-mobile-web-app-status-bar-style:
 * black-translucent` was dropped: while the page ran UNDER the status bar the
 * overflow went under it too and nobody saw it.
 *
 * Asserted as CSS text because neither jsdom nor a headless browser can see
 * it: jsdom does no layout, and a desktop browser reports a 0 inset, so the
 * bug only exists where we cannot look. Measured by hand instead, with the
 * inset simulated at 59px: layout 844 against an 844 viewport, tab bar bottom
 * at 844 — on screen. Without border-box it was 903.
 */
describe('.app-layout', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
  const block = css.slice(
    css.indexOf('.app-layout {'),
    css.indexOf('}', css.indexOf('.app-layout {')),
  );

  it('keeps the safe-area padding INSIDE its height', () => {
    expect(block).toContain('padding-top: env(safe-area-inset-top)');
    expect(block).toContain('box-sizing: border-box');
  });

  it('still reserves the status bar at all, for installs that predate the meta change', () => {
    // An app added to the home screen BEFORE the translucent meta was dropped
    // keeps the translucent bar until it is removed and re-added, and on those
    // the page still runs underneath and still needs the room.
    expect(block).toMatch(/padding-top:\s*env\(safe-area-inset-top\)/);
  });
});
