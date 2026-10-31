import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE MOBILE SHEET IS NOT A RAIL ISLAND, AND HALF THE RAIL'S COLOURS ASSUMED
 * IT WAS.
 *
 * `.navtree[data-variant="sidebar"]` and `.sidenav` rebind --fg, --accent and
 * the rest to the rail's own values, because a deep rail on a light app needs
 * its own ink. The sheet does not: it sits on the app's ground, so inside it
 * those tokens resolve to the APP's.
 *
 * Anything that asked for `--rail-ink` or `--rail-accent` BY NAME therefore
 * pinned a deep-surface colour onto a light one. Measured on memphis — black
 * rail, near-white rail ink, yellow rail accent — the sheet's section header
 * came out at 1.3:1 and the band's label at 1.7:1. Reported as "sidebar on
 * mobile… we have some issues here clearly in terms of contrast, and I
 * suspect this is probably the case for some of the other themes as well".
 *
 * The rule: components ask for the GENERIC token and let the island rebind
 * it. A `--rail-*` name belongs in the island declaration and nowhere else.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const NAV = readFileSync(join(HERE, 'NavTree.css'), 'utf8');
const STYLES = readFileSync(join(HERE, '..', 'styles.css'), 'utf8');

const flat = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
type Rule = { sel: string; body: string };
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of flat(css).matchAll(/([^{}]+)\{([^{}]*)\}/g))
    for (const part of (m[1] ?? '').split(','))
      if (part.trim()) out.push({ sel: part.trim().replace(/\s+/g, ' '), body: m[2] ?? '' });
  return out;
}
/** Is this selector inside one of the two surfaces that rebind the tokens? */
const island = (sel: string) => sel.includes('data-variant="sidebar"') || sel.includes('.sidenav');

describe('nothing paints a sheet with the rail’s palette', () => {
  it('finds the island declarations, so the generic tokens really are rebound', () => {
    const decls = rules(NAV).filter(
      (r) => island(r.sel) && r.body.includes('--fg: var(--rail-ink)'),
    );
    expect(decls.length).toBeGreaterThanOrEqual(2);
    // …including the accent, which is what the band's label and seam use.
    expect(decls.some((d) => d.body.includes('--accent: var(--rail-accent)'))).toBe(true);
  });

  it('names no --rail-* token outside an island, in the component sheet', () => {
    const leaks = rules(NAV)
      .filter((r) => !island(r.sel))
      .flatMap((r) =>
        r.body
          .split(';')
          .filter((d) => /--rail-[\w-]+\)/.test(d) && !d.trim().startsWith('--'))
          .map((d) => `${r.sel} → ${d.trim()}`),
      );
    expect(leaks, 'these pin a rail colour onto whatever surface they land on').toEqual([]);
  });

  it('names no --rail-* ink in a theme rule that is not island-scoped', () => {
    const leaks = rules(STYLES)
      .filter((r) => r.sel.includes('[data-theme=') && !island(r.sel))
      .flatMap((r) =>
        r.body
          .split(';')
          .filter((d) => /^\s*color\s*:/.test(d) && d.includes('--rail-'))
          .map((d) => `${r.sel} → ${d.trim()}`),
      );
    expect(leaks).toEqual([]);
  });
});

/**
 * …AND THE BAND READS ON BOTH SURFACES, computed per theme.
 */
describe('the recently-active band, on the sheet as well as the rail', () => {
  const rgb = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  };
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) =>
    (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const mix = (a: string, b: string, pct: number) =>
    rgb(a).map((v, i) => Math.round((v * pct) / 100 + (rgb(b)[i] as number) * (1 - pct / 100)));

  interface Surface {
    theme: string;
    where: string;
    ground: string;
    accent: string;
    ink: string;
    fg: string;
  }
  const surfaces: Surface[] = [];
  for (const m of STYLES.matchAll(/\[data-theme="([^"]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
    const [, theme, body] = m;
    if (!theme || !body) continue;
    const tok = (k: string) => new RegExp(`--${k}:\\s*(#[0-9a-fA-F]{3,8});`).exec(body)?.[1];
    const fg = tok('fg');
    const elev = tok('bg-elev');
    const accent = tok('accent');
    if (fg && elev && accent)
      surfaces.push({ theme, where: 'sheet', ground: elev, accent, ink: fg, fg });
    const rs = tok('rail-surface');
    const ra = tok('rail-accent') ?? accent;
    const ri = tok('rail-ink');
    if (fg && rs && ra && ri)
      surfaces.push({ theme, where: 'rail', ground: rs, accent: ra, ink: ri, fg });
  }

  it('finds both surfaces of every theme', () => {
    expect(surfaces.length).toBeGreaterThanOrEqual(12);
  });

  it.each(surfaces.map((s) => [`${s.theme} ${s.where}`, s] as const))(
    '%s keeps the band label readable',
    (_n, s) => {
      // ground + the band's 6% lift, then the label's 55% accent into full ink.
      const band = mix(s.fg, s.ground, 6);
      const label = rgb(s.ink).map((v, i) =>
        Math.round((rgb(s.accent)[i] as number) * 0.55 + v * 0.45),
      );
      expect(ratio(label, band as number[])).toBeGreaterThanOrEqual(4.5);
    },
  );
});
