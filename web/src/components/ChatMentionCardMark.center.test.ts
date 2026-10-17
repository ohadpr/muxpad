import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE LIFECYCLE MARK IS DRAWN BY ARITHMETIC, SO IT IS CHECKED BY ARITHMETIC.
 *
 * Two complaints, one root. "done and started still differently styled" and
 * "checkmark icon in done is not centered in circle container."
 *
 * ─── WHY THEY LOOKED LIKE DIFFERENT STYLES ──────────────────────────────────
 * The tick box carried `background: color-mix(--state-hue, 22%)`. One recipe,
 * but the hue is the variable: --chat-faint at 22% is invisible on the card and
 * --status-ready at 22% is a solid green coin. So the pair rendered as a bare
 * grey ring beside a filled green badge — the same fault the PILL had one round
 * earlier, arriving through the disc instead. The disc is gone; what makes the
 * two one object is the slot, the stroke weight and one optical size, with the
 * hue as the only difference. That is already the rule for the word beside it.
 *
 * ─── WHY THE TICK WAS OFF-CENTRE ────────────────────────────────────────────
 * Every mark here is positioned absolutely inside a 13px box, so "centred"
 * means the INK's bounding box is centred on (6.5, 6.5) — and for the tick the
 * ink is not the element. A checkmark is `border-right` + `border-bottom` of a
 * w×h box turned 45°: two SIDES of the box, not the box. Its three corners land
 * at ±(w+h)/2·sin45 across and between (w−h)/2·sin45 and (w+h)/2·sin45 down, so
 * the ink sits w·sin45/2 BELOW the element's own centre and the element has to
 * be hung that much high. It was centred as if it were the box, which put it
 * 1.4px low — and 9.2px wide next to a 6px ring, which is the other half of
 * "differently styled".
 *
 * This file recomputes those bounding boxes from the declarations themselves,
 * so a future nudge to any offset has to stay centred to pass. It is a CSS test
 * rather than a rendering one for the reason the sibling pill test gives: jsdom
 * has no layout, and Chromium snaps paint to whole CSS pixels under the zoom a
 * measurement needs — it cannot resolve the half-pixels these rules trade in.
 */

const CSS = readFileSync(join(__dirname, 'ChatMentionPicker.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The 13px box every mark is drawn inside. Its centre is what they centre on. */
const BOX = 13;
const C = BOX / 2;
const SIN45 = Math.SQRT1_2;
/** Half a CSS pixel. Paint snaps to whole pixels, so this is the real floor. */
const TOL = 0.5;

function rule(selector: string): string {
  const m = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((x) => (x[1] ?? '').trim() === selector);
  if (!m) throw new Error(`no rule for ${selector}`);
  return (m[2] ?? '').trim();
}
function px(body: string, prop: string): number {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?[\\d.]+)px`).exec(body);
  if (!m) throw new Error(`no ${prop} in ${body}`);
  return Number(m[1]);
}
/** An axis-aligned pseudo-element's ink box: it IS its border box. */
function plain(sel: string) {
  const b = rule(sel);
  const [l, t, w, h] = [px(b, 'left'), px(b, 'top'), px(b, 'width'), px(b, 'height')];
  return { x0: l, x1: l + w, y0: t, y1: t + h };
}
const centre = (k: { x0: number; x1: number; y0: number; y1: number }) => ({
  cx: (k.x0 + k.x1) / 2,
  cy: (k.y0 + k.y1) / 2,
  w: k.x1 - k.x0,
  h: k.y1 - k.y0,
});
const union = (...ks: ReturnType<typeof plain>[]) => ({
  x0: Math.min(...ks.map((k) => k.x0)),
  x1: Math.max(...ks.map((k) => k.x1)),
  y0: Math.min(...ks.map((k) => k.y0)),
  y1: Math.max(...ks.map((k) => k.y1)),
});
/** A bar of `w`×`h` rotated about its own centre: the rotation is symmetric, so
 *  the ink stays centred on the element and only its extent grows. */
function rotatedBar(sel: string) {
  const b = rule(sel);
  const [l, t, w, h] = [px(b, 'left'), px(b, 'top'), px(b, 'width'), px(b, 'height')];
  const cx = l + w / 2;
  const cy = t + h / 2;
  const half = ((w + h) / 2) * SIN45;
  return { x0: cx - half, x1: cx + half, y0: cy - half, y1: cy + half };
}
/** The checkmark: two SIDES of a w×h box, turned 45° about the box's centre. */
function rotatedL(sel: string) {
  const b = rule(sel);
  const [l, t, w, h] = [px(b, 'left'), px(b, 'top'), px(b, 'width'), px(b, 'height')];
  const cx = l + w / 2;
  const cy = t + h / 2;
  const across = ((w + h) / 2) * SIN45;
  return { x0: cx - across, x1: cx + across, y0: cy + ((w - h) / 2) * SIN45, y1: cy + across };
}

/** Every mark, and the ink box its declarations produce. */
const MARKS: Record<string, ReturnType<typeof plain>> = {
  started: plain('.chat-mention-card-tick[data-state="started"]::after'),
  delivered: rotatedL('.chat-mention-card-tick[data-state="delivered"]::after'),
  failed: union(
    rotatedBar('.chat-mention-card-tick[data-state="failed"]::after'),
    rotatedBar('.chat-mention-card-tick[data-state="failed"]::before'),
  ),
  awaiting: union(
    plain('.chat-mention-card-tick[data-state="awaiting"]::after'),
    plain('.chat-mention-card-tick[data-state="awaiting"]::before'),
  ),
  done: plain('.chat-mention-card-tick[data-state="done"]::after'),
};

describe('every lifecycle mark is centred in its 13px box', () => {
  for (const [state, ink] of Object.entries(MARKS)) {
    it(`${state} — ink centred on (6.5, 6.5)`, () => {
      const { cx, cy } = centre(ink);
      expect(Math.abs(cx - C)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(cy - C)).toBeLessThanOrEqual(TOL);
    });
    it(`${state} — stays inside the box`, () => {
      expect(ink.x0).toBeGreaterThanOrEqual(0);
      expect(ink.y0).toBeGreaterThanOrEqual(0);
      expect(ink.x1).toBeLessThanOrEqual(BOX);
      expect(ink.y1).toBeLessThanOrEqual(BOX);
    });
  }

  it('the tick was the one that was wrong, and by the amount claimed', () => {
    // The regression, stated as a number: centring the element instead of the
    // ink puts a w=4 checkmark w·sin45/2 = 1.41px low. If this ever reads zero
    // the correction above has been silently removed along with the fault.
    expect((4 * SIN45) / 2).toBeCloseTo(1.41, 2);
  });
});

describe('started and done are one object', () => {
  const size = (k: ReturnType<typeof plain>) => Math.max(centre(k).w, centre(k).h);

  it('no hue-dependent plate behind any of them', () => {
    // --chat-faint at 22% is invisible and --status-ready at 22% is a coin.
    // A `background` keyed to --state-hue is what made one recipe render as two
    // styles; the pill fell to the same rule one round earlier.
    expect(rule('.chat-mention-card-tick')).not.toMatch(/background/);
  });

  it('every glyph is the same optical size', () => {
    const sizes = Object.values(MARKS)
      .filter((k) => k !== MARKS.done) // the dot says least on purpose
      .map(size);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('the only thing that differs between the states is the hue', () => {
    // …and it is declared ONCE, on the CHIP, which is the tick's parent. It
    // used to be declared on the tick itself — so the chip had no --state-hue
    // of its own and its `color: color-mix(…, var(--state-hue), …)` was an
    // invalid value that fell back to the inherited text colour. That is the
    // whole reason `DONE` was a black word beside a green mark. Custom
    // properties inherit downward; one declaration feeds both elements and
    // there is no second copy to disagree.
    for (const state of ['started', 'delivered', 'failed', 'awaiting', 'done']) {
      const body = rule(`.chat-mention-card-state[data-state="${state}"]`);
      expect(body.replace(/\s/g, '')).toMatch(/^--state-hue:[^;]+;?$/);
      // The tick must NOT redeclare it.
      expect(CSS).not.toMatch(
        new RegExp(`\\.chat-mention-card-tick\\[data-state="${state}"\\]\\s*\\{[^}]*--state-hue`),
      );
    }
  });

  it('the pair both wear a PLATE, and neither plate is keyed to a grey', () => {
    // The plate was removed because one recipe — the hue at 22% — made a
    // visible green badge and an invisible grey one, so the two read as
    // different objects. Removing it made them consistent and flat: "both
    // should have bg color like before". The fault was keying a wash to a hue
    // with no chroma, so the achromatic states take a NEUTRAL plate instead.
    expect(rule('.chat-mention-card-state')).toMatch(/background:\s*var\(--state-plate\)/);
    const neutral = rule(
      '.chat-mention-card-state[data-state="started"],\n.chat-mention-card-state[data-state="done"]',
    );
    expect(neutral).toMatch(/--state-plate:[^;]*--chat-fg/);
    expect(neutral).not.toMatch(/--state-plate:[^;]*--state-hue/);
  });

  it('DONE is green, not a tinted black', () => {
    // "especially done should be greener." The ink was the hue at
    // --status-ink-mix (50–55%) — half the status colour, half the card's own
    // text — which on a near-black text ink is a grey-green. The status colour
    // has to be the majority of it.
    const m = /--state-ink:\s*color-mix\(in srgb,\s*var\(--state-hue\)\s*(\d+)%/.exec(CSS);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(70);
  });
});
