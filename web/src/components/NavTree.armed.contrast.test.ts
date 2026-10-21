import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE ARMED CONTROL HAS TO BE READABLE, ON EVERY THEME.
 *
 * "Click again to delete" is the whole of what replaced `window.confirm` — a
 * system dialog that was unmissable by construction. If its label is hard to
 * read on one theme, the thing that guards five destructive actions is weaker
 * than what it replaced, and nothing else in the app would notice.
 *
 * The fill is `--armed-fill` (--danger mixed with 12% --fg) and the ink is
 * `--bg`. Raw --danger does NOT pass here: acme sits at 4.18:1 and dracula at
 * 4.53:1 against their own backgrounds, which is why the mix exists. Computed
 * from the stylesheet rather than asserted, so a theme added later fails here
 * instead of on somebody's screen.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'styles.css'), 'utf8');

const rgb = (hex: string) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
};
const luminance = (c: number[]) => {
  const ch = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a: number[], b: number[]) => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** `color-mix(in srgb, a P%, b)`. */
const mix = (a: string, b: string, pct: number) =>
  rgb(a).map((v, i) => Math.round((v * pct) / 100 + (rgb(b)[i] as number) * (1 - pct / 100)));

type Theme = { name: string; danger: string; bg: string; fg: string };
function themes(): Theme[] {
  const out: Theme[] = [];
  for (const match of CSS.matchAll(/\[data-theme="([^"]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
    const [, sel, body] = match;
    if (!sel || !body) continue;
    const danger = /--danger:\s*(#[0-9a-f]{3,8});/i.exec(body)?.[1];
    const bg = /--bg:\s*(#[0-9a-f]{3,8});/i.exec(body)?.[1];
    const fg = /--fg:\s*(#[0-9a-f]{3,8});/i.exec(body)?.[1];
    if (danger && bg && fg) out.push({ name: sel, danger, bg, fg });
  }
  return out;
}

/** The mix the token declares, read from the stylesheet — so changing the
 *  percentage changes what this test measures, instead of silently drifting
 *  away from it. */
function armedMixPercent(): number {
  const rule = /--armed-fill:\s*color-mix\(in srgb,\s*var\(--danger\)\s*(\d+)%/.exec(CSS);
  expect(rule).not.toBeNull();
  return Number(rule?.[1]);
}

describe('the armed destructive control, on every theme that ships', () => {
  it('finds the themes and the token', () => {
    expect(themes().length).toBeGreaterThanOrEqual(6);
    expect(armedMixPercent()).toBeGreaterThan(0);
  });

  it('is AA-legible — the label is --bg on --armed-fill', () => {
    const pct = armedMixPercent();
    const measured = themes().map((t) => ({
      name: t.name,
      r: Number(ratio(mix(t.danger, t.fg, pct), rgb(t.bg)).toFixed(2)),
    }));
    for (const m of measured) expect(m.r, `${m.name} armed label`).toBeGreaterThanOrEqual(4.5);
  });

  it('records why the mix is there: raw --danger would fail', () => {
    // Not decoration. If a later change points --armed-fill back at --danger,
    // the test above goes red and this says what the mix was buying.
    const raw = themes().map((t) => ratio(rgb(t.danger), rgb(t.bg)));
    expect(Math.min(...raw)).toBeLessThan(4.5);
  });
});
