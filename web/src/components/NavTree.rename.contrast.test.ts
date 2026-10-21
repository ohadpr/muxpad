import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE RENAME FIELD, ON BOTH SURFACES.
 *
 * This is the FOURTH time this control has been a colour on its own colour,
 * and every previous fix was right about one surface and silent about the
 * other:
 *
 *   --bg          the PAGE background under the RAIL's ink — 1.00:1 on
 *                 github-light, 1.09 alucard, 1.06 acme. Fixed by…
 *   --rail-elev   …which fixed the sidebar and broke the SHEET, where --fg is
 *                 NOT rebound (the island is scoped to
 *                 `[data-variant="sidebar"]`): 1.66:1 alucard, 1.68
 *                 github-light, 2.05 acme. Reported with a screenshot.
 *   --bg-elev     the token the island itself rebinds, so one declaration is
 *                 the rail's surface inside the rail and the page's outside.
 *
 * So this measures BOTH pairs, because the failure mode is a fix that only
 * looks at one of them. The ink is always --fg; what changes is which family
 * --fg and the surface come from.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, '..', 'styles.css'), 'utf8');
const TREE = readFileSync(join(HERE, 'NavTree.css'), 'utf8');

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
const mix = (a: number[], b: number[], pct: number) =>
  a.map((v, i) => Math.round((v * pct) / 100 + (b[i] as number) * (1 - pct / 100)));

/** `--rail-elev: color-mix(in srgb, var(--rail-ink) N%, var(--rail-surface))`,
 *  read from the stylesheet so the percentage cannot drift from this test. */
const railElevPercent = () =>
  Number(
    /--rail-elev:\s*color-mix\(in srgb,\s*var\(--rail-ink\)\s*(\d+)%/.exec(STYLES)?.[1] ??
      Number.NaN,
  );

type Theme = { name: string; fg: string; bgElev: string; railInk: string; railSurface: string };
function themes(): Theme[] {
  const out: Theme[] = [];
  for (const m of STYLES.matchAll(/\[data-theme="([^"]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = m;
    if (!name || !body) continue;
    const pick = (k: string) =>
      new RegExp(`--${k}:\\s*(#[0-9a-f]{3,8});`, 'i').exec(body)?.[1] ?? '';
    const t = {
      name,
      fg: pick('fg'),
      bgElev: pick('bg-elev'),
      railInk: pick('rail-ink'),
      railSurface: pick('rail-surface'),
    };
    if (t.fg && t.bgElev && t.railInk && t.railSurface) out.push(t);
  }
  return out;
}

describe('the inline rename field', () => {
  it('finds the themes and the rail-elev recipe', () => {
    expect(themes().length).toBeGreaterThanOrEqual(6);
    expect(railElevPercent()).toBeGreaterThan(0);
  });

  it('takes --bg-elev, the token the island rebinds — not a hardcoded rail colour', () => {
    const rule = TREE.slice(TREE.indexOf('.navtree-rename {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('background: var(--bg-elev)');
    expect(body).not.toContain('var(--rail-elev)');
    expect(body).not.toContain('background: var(--bg)');
  });

  it('is legible ON THE SHEET, where --fg is the page ink', () => {
    for (const t of themes())
      expect(ratio(rgb(t.fg), rgb(t.bgElev)), `${t.name} sheet rename`).toBeGreaterThanOrEqual(4.5);
  });

  it('is legible IN THE SIDEBAR, where the island rebinds both', () => {
    const pct = railElevPercent();
    for (const t of themes()) {
      const elev = mix(rgb(t.railInk), rgb(t.railSurface), pct);
      expect(ratio(rgb(t.railInk), elev), `${t.name} sidebar rename`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('paints its own band on the sheet — nothing else does it there', () => {
    // The row is deliberately NOT wrapped in a SwipeRow while editing, and the
    // swipe FACE is what fills every other row on that surface. Without this
    // the page shows through as a pale slab mid-list.
    const i = TREE.indexOf('.navtree[data-variant="sheet"] .navtree-tab-row:has(.navtree-rename)');
    expect(i).toBeGreaterThan(-1);
    expect(TREE.slice(i, TREE.indexOf('}', i))).toContain('background-color: var(--swipe-surface)');
  });
});
