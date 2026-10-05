import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIN_SHEET_HEIGHT,
  SHEET_BOTTOM_MARGIN,
  SHEET_SETTLE_MS,
  sheetMaxHeight,
} from './sheet-viewport';

/**
 * The mobile nav sheet under a software keyboard.
 *
 * ─── The defect, measured ────────────────────────────────────────────────
 * iPhone-14 metrics (390×844), nav sheet open, search box focused, query "i"
 * (12 tab results). The layout viewport does NOT shrink when iOS raises the
 * keyboard, so before the fix:
 *
 *   .mns-panel      max-height 750px  (100svh − 46 − 48), bottom at y=796
 *   .navtree-scroll scrollHeight 627 === clientHeight 627  → NOT scrollable
 *   rows 8..12      y 508..743, i.e. under a 336px keyboard
 *   maxScrollTop    0
 *
 * Five of twelve results were therefore not merely off-screen but
 * UNREACHABLE — the container had no overflow to scroll. That is the whole
 * point of the arithmetic below: cap the panel by the visual viewport, the
 * scroller regains its overflow, and every row is reachable again.
 */

const KEYBOARD = 336;
const PANEL_TOP = 46; // safe-area inset + chrome height on an iPhone 14
const LAYOUT_H = 844;

describe('sheetMaxHeight — the panel is capped by the VISUAL viewport', () => {
  it('subtracts the keyboard, so the scroller regains its overflow', () => {
    const withKeyboard = sheetMaxHeight(
      { height: LAYOUT_H - KEYBOARD, offsetTop: 0 },
      PANEL_TOP,
      SHEET_BOTTOM_MARGIN,
    );
    // 508 − 46 − 24 = 438, against the 774 the stylesheet alone would allow.
    // The margin was 48 and is 24: the panel measured 89% of a chromeless
    // viewport while reading as "half the screen" on a real phone, because the
    // stylesheet's fallback term used `svh` — the SMALLEST viewport, i.e. the
    // height with browser chrome fully expanded. It uses `dvh` now, and the
    // reserved scrim band was halved, since the chrome bar above the panel
    // closes it too and this band is the second way out, not the only one.
    expect(withKeyboard).toBe(438);
    const contentHeight = 627; // measured: 12 result rows
    expect(contentHeight).toBeGreaterThan(withKeyboard as number);
  });

  it('adds offsetTop back, because the panel is fixed to the LAYOUT viewport', () => {
    // iOS scrolls the visual viewport down to reveal a focused field. The
    // panel does not move with it, so its usable bottom edge moves down too —
    // dropping offsetTop would cap the panel short by exactly that much.
    const scrolled = sheetMaxHeight(
      { height: LAYOUT_H - KEYBOARD, offsetTop: 60 },
      PANEL_TOP,
      SHEET_BOTTOM_MARGIN,
    );
    expect(scrolled).toBe(438 + 60);
  });

  it('is a no-op with no keyboard: the cap lands at the stylesheet’s own value', () => {
    const idle = sheetMaxHeight({ height: LAYOUT_H, offsetTop: 0 }, PANEL_TOP, SHEET_BOTTOM_MARGIN);
    expect(idle).toBe(LAYOUT_H - PANEL_TOP - SHEET_BOTTOM_MARGIN); // 774
  });

  it('never collapses to a sliver, however little the keyboard leaves', () => {
    // Landscape phone, keyboard up: a 0px panel reads as "the sheet vanished
    // when I tapped search", which is worse than two rows you can scroll.
    const cramped = sheetMaxHeight({ height: 120, offsetTop: 0 }, PANEL_TOP, SHEET_BOTTOM_MARGIN);
    expect(cramped).toBe(MIN_SHEET_HEIGHT);
  });

  it('leaves the stylesheet alone where visualViewport is unsupported', () => {
    // `null`, not a number: the caller must NOT set the custom property, so
    // the CSS fallback keeps the svh cap.
    expect(sheetMaxHeight(null, PANEL_TOP, SHEET_BOTTOM_MARGIN)).toBeNull();
  });
});

describe('the CSS actually consumes it', () => {
  const CSS = readFileSync(
    join(import.meta.dirname, '..', 'components', 'MobileNavSwitcher.css'),
    'utf8',
  );

  it('caps .mns-panel with min(dvh, --mns-avail-h)', () => {
    // Via `--mns-h` now: one property read by both the floor and the ceiling,
    // so the two cannot drift. The assertions follow the indirection rather
    // than pinning the spelling of the declaration.
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    const panel = flat.match(/\.mns-panel \{([^}]*)\}/)?.[1] ?? '';
    expect(panel).toMatch(/max-height:\s*var\(--mns-h\)/);
    expect(panel).toMatch(/--mns-h:\s*min\(/);
    expect(panel).toContain('--mns-avail-h');
    // A bare `var(--mns-avail-h)` with no fallback would leave the panel
    // UNCAPPED on a browser without visualViewport — the property would be
    // invalid at computed-value time and max-height would drop to `none`.
    // The fallback stands in for the screen term, so it carries the same
    // fraction — what matters is that it EXISTS and resolves to a length.
    expect(panel).toMatch(/var\(--mns-avail-h,\s*calc\(/);
    expect(panel).toContain('100dvh');
  });

  it('also claims a FLOOR, and the floor can never beat the ceiling', () => {
    // The half-height complaint was not the cap — on an 844px phone that
    // computes to ~727px. The panel has no `height`, so it hugs its content,
    // and the sheet inherits each workspace's collapsed state: a typical open
    // is one expanded group of half a dozen rows, which lands near half the
    // viewport. The floor stops it choosing to be small.
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    const panel = flat.match(/\.mns-panel \{([^}]*)\}/)?.[1] ?? '';
    expect(panel).toMatch(/min-height:\s*var\(--mns-h\)/);
    // THE LOAD-BEARING PART. A min-height beats a max-height in CSS, so a bare
    // `68dvh` floor would win over the visual-viewport cap on a short viewport
    // — landscape, or the keyboard up — and hand back a panel taller than the
    // screen with its last rows unreachable. The floor has to carry the same
    // cap terms so it can never exceed them.
    const h = panel.match(/--mns-h:\s*min\(([^;]*)\)/)?.[1] ?? '';
    expect(h).toContain('--mns-avail-h');
    expect(h).toContain('--mns-panel-top');
  });

  it('the JS margin and the CSS margin are the same number', () => {
    // Two spellings of the scrim band. If one moves and the other doesn't,
    // the panel and the "tap outside to dismiss" target stop agreeing.
    const marginsInCss = [...CSS.matchAll(/100dvh - var\(--mns-panel-top\) - (\d+)px/g)].map((m) =>
      Number(m[1]),
    );
    expect(marginsInCss.length).toBeGreaterThan(0);
    for (const m of marginsInCss) expect(m).toBe(SHEET_BOTTOM_MARGIN);
  });
});

describe('the sheet’s search box clears the touch floor', () => {
  const CSS = readFileSync(join(import.meta.dirname, '..', 'components', 'NavSearch.css'), 'utf8');

  it('is 44px in the sheet variant — the same floor as the tab rows', () => {
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    const body =
      flat.match(/\.navsearch\[data-variant="sheet"\] \.navsearch-input \{([^}]*)\}/)?.[1] ?? '';
    const height = Number(body.match(/height:\s*(\d+)px/)?.[1]);
    expect(height).toBeGreaterThanOrEqual(44);
  });

  it('keeps the 16px font that stops iOS zooming the page on focus', () => {
    // The classic cause of "the whole app zoomed when I tapped search". A
    // taller box alone does not prevent it; the FONT is what iOS reads.
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    const body =
      flat.match(/\.navsearch\[data-variant="sheet"\] \.navsearch-input \{([^}]*)\}/)?.[1] ?? '';
    expect(Number(body.match(/font-size:\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(16);
  });
});

/**
 * HOW TALL THE SHEET OPENS — reported twice as "it takes half the screen".
 *
 * The cap was never the problem: at 430×900 it resolves to 830px, 92% of the
 * screen. The panel has no `height`, so it HUGS ITS CONTENT, and the content is
 * short whenever workspaces are left folded. A floor was added for that, at 68%
 * — but of AVAILABLE, which is already the viewport minus the chrome above the
 * panel minus the bottom margin. Measured: `min-height: 564px` against a 900px
 * viewport, 63% of the screen, and nearer 58% on a phone with safe-area insets.
 * Two thirds of five sixths is not two thirds, and a reader seeing it half-full
 * calls it half.
 *
 * So the floor IS the ceiling: the sheet claims all the available height every
 * time. The panel scrolls internally, so a tall sheet with little in it costs
 * only space that was going to be scrim — and the alternative is a panel whose
 * height depends on how many groups you happen to have left folded, which is
 * inconsistent as well as small.
 */
describe('the nav sheet has one height, and leaves room to dismiss', () => {
  const CSS = readFileSync(
    join(import.meta.dirname, '..', 'components', 'MobileNavSwitcher.css'),
    'utf8',
  );
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const panel = flat.match(/\.mns-panel \{([^}]*)\}/)?.[1] ?? '';
  const decl = (prop: string) =>
    panel.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim() ?? '';

  it('sets a floor AND a ceiling — a cap alone lets it hug short content', () => {
    // Without a floor the panel's height tracked how many workspaces happened
    // to be folded, which is how it could look full one moment and short the
    // next with nothing having changed.
    expect(decl('max-height')).not.toBe('');
    expect(decl('min-height')).not.toBe('');
  });

  it('and they are literally the same value, not two expressions to keep in step', () => {
    expect(decl('min-height')).toBe(decl('max-height'));
    expect(decl('min-height')).toBe('var(--mns-h)');
  });

  it('leaves a strip of scrim to tap — the panel is not the whole screen', () => {
    // A sheet that claims everything is readable and inescapable: every pixel
    // is a row, so there is nowhere to tap that does not navigate.
    const h = decl('--mns-h');
    const pct = Number(h.match(/\*\s*(0?\.\d+)/)?.[1]);
    expect(pct).toBeGreaterThan(0.7);
    expect(pct).toBeLessThan(0.95);
  });

  it('does NOT shrink the keyboard-clamped term — that is the compounding bug', () => {
    // The fraction belongs to the screen term only. Applied to BOTH, it shrinks
    // an already-shrunken viewport: 68% of a number that is itself five sixths
    // of the screen is 56%, which is what "it takes half the screen" was.
    const h = decl('--mns-h');
    const clamp = h.match(/var\(--mns-avail-h[^)]*\)[^)]*\)?/)?.[0] ?? '';
    expect(h).toContain('--mns-avail-h');
    // the live value itself is used unscaled; only its FALLBACK carries the
    // fraction, because the fallback stands in for the screen term.
    expect(clamp).not.toMatch(/var\(--mns-avail-h\)\s*\*/);
  });

  it('still clamps to the live visual viewport, so a keyboard cannot orphan rows', () => {
    expect(decl('--mns-h')).toMatch(/^min\(/);
    expect(decl('--mns-h')).toContain('--mns-avail-h');
  });
});

describe('the viewport is re-measured across the keyboard animation', () => {
  const SRC = readFileSync(
    join(import.meta.dirname, '..', 'components', 'MobileNavSwitcher.tsx'),
    'utf8',
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('opening tracks for a window — it does not take a single reading', () => {
    // The effect's last statement before subscribing is what runs on OPEN. A
    // bare `apply()` there is the bug: correct exactly when no keyboard is
    // moving, which is most of the time, which is what made it intermittent.
    expect(code).toMatch(/trackUntil\(Date\.now\(\) \+ SHEET_SETTLE_MS\);\s*\n\s*vv\.addEventListener\('resize'/);
  });

  it('uses the same settle window for focus changes, from one constant', () => {
    // Both paths exist for the identical reason; two numbers would drift.
    expect(code.match(/trackUntil\(Date\.now\(\) \+ SHEET_SETTLE_MS\)/g)).toHaveLength(2);
    expect(code).not.toMatch(/trackUntil\(Date\.now\(\) \+ \d+\)/);
  });

  it('the window outlasts a keyboard animation', () => {
    // iOS keyboard transitions are ~250-350ms. A window shorter than that
    // reinstates the bug while looking like it has a fix.
    expect(SHEET_SETTLE_MS).toBeGreaterThanOrEqual(500);
  });
});
