import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_SHEET_HEIGHT, SHEET_BOTTOM_MARGIN, sheetMaxHeight } from './sheet-viewport';

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
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    const panel = flat.match(/\.mns-panel \{([^}]*)\}/)?.[1] ?? '';
    expect(panel).toMatch(/max-height:\s*min\(/);
    expect(panel).toContain('--mns-avail-h');
    // A bare `var(--mns-avail-h)` with no fallback would leave the panel
    // UNCAPPED on a browser without visualViewport — the property would be
    // invalid at computed-value time and max-height would drop to `none`.
    expect(panel).toMatch(/var\(--mns-avail-h,\s*calc\(100dvh/);
  });

  it('also claims a FLOOR, and the floor can never beat the ceiling', () => {
    // The half-height complaint was not the cap — on an 844px phone that
    // computes to ~727px. The panel has no `height`, so it hugs its content,
    // and the sheet inherits each workspace's collapsed state: a typical open
    // is one expanded group of half a dozen rows, which lands near half the
    // viewport. The floor stops it choosing to be small.
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
    const panel = flat.match(/\.mns-panel \{([^}]*)\}/)?.[1] ?? '';
    expect(panel).toMatch(/min-height:\s*min\(/);
    // THE LOAD-BEARING PART. A min-height beats a max-height in CSS, so a bare
    // `68dvh` floor would win over the visual-viewport cap on a short viewport
    // — landscape, or the keyboard up — and hand back a panel taller than the
    // screen with its last rows unreachable. The floor has to carry the same
    // cap terms so it can never exceed them.
    const minH = panel.match(/min-height:\s*min\(([^;]*)\)/)?.[1] ?? '';
    expect(minH).toContain('--mns-avail-h');
    expect(minH).toContain('--mns-panel-top');
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
describe('the nav sheet opens to the full available height', () => {
  const CSS = readFileSync(
    join(import.meta.dirname, '..', 'components', 'MobileNavSwitcher.css'),
    'utf8',
  );
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const panel = flat.match(/\.mns-panel \{([^}]*)\}/)?.[1] ?? '';
  const decl = (prop: string) =>
    panel.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim() ?? '';

  it('has both a floor and a ceiling — a cap alone lets it hug short content', () => {
    expect(decl('max-height')).not.toBe('');
    expect(decl('min-height')).not.toBe('');
  });

  it('and they are the SAME expression, so height cannot depend on fold state', () => {
    expect(decl('min-height')).toBe(decl('max-height'));
  });

  it('carries no fraction — that is how it became 63% of the screen', () => {
    // A factor here multiplies a number that is ALREADY a fraction of the
    // viewport, which is the whole bug. If a future change wants a shorter
    // sheet it has to say so against the viewport, not against the cap.
    expect(decl('min-height')).not.toMatch(/\*\s*0?\.\d/);
  });

  it('still clamps to the live visual viewport, so a keyboard cannot orphan rows', () => {
    // The reason the floor can safely equal the ceiling at all: both terms go
    // through the same `min()` against `--mns-avail-h`, so a floor can never
    // exceed the space that actually exists. A bare `68dvh` floor could, and a
    // min-height beats a max-height in CSS.
    expect(decl('min-height')).toContain('--mns-avail-h');
    expect(decl('min-height')).toMatch(/^min\(/);
  });
});
