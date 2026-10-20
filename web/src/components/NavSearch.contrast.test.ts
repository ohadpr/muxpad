import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE SEARCH FIELD MUST NOT BE INK ON ITS OWN COLOUR.
 *
 * The rail is an island: it rebinds `--fg` to `--rail-ink` so its text is
 * readable on a deep surface. `.navsearch` takes its background from
 * `--bg-elev` — and that was NOT rebound, so it stayed the app's elevated
 * colour. On every theme with a light app and a deep rail the two are the
 * same value, and the field rendered white on white: alucard, github-light
 * and acme all measured exactly 1.00:1. Reported as "when focusing the search
 * bar and writing something the text seems to be rendered hidden somehow".
 *
 * This computes the ratio from the stylesheet rather than trusting the fix, so
 * a theme added later — or a token quietly re-pointed — fails here instead of
 * on somebody's phone.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'styles.css'), 'utf8');
const TREE = readFileSync(join(HERE, 'NavTree.css'), 'utf8');

type Theme = { name: string; ink: string; surface: string };

function themes(): Theme[] {
  const out: Theme[] = [];
  for (const match of CSS.matchAll(/\[data-theme="([^"]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
    const [, sel, body] = match;
    if (!sel || !body) continue;
    const ink = /--rail-ink:\s*(#[0-9a-f]{3,8});/i.exec(body)?.[1];
    const surface = /--rail-surface:\s*(#[0-9a-f]{3,8});/i.exec(body)?.[1];
    if (ink && surface) out.push({ name: sel, ink, surface });
  }
  return out;
}

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
/** What `color-mix(in srgb, <ink> P%, <surface>)` resolves to. */
const mix = (ink: string, surface: string, pct: number) =>
  rgb(ink).map((v, i) =>
    Math.round((v * pct) / 100 + (rgb(surface)[i] as number) * (1 - pct / 100)),
  );

describe('the rail search field, on every theme that ships', () => {
  it('finds the themes to check at all', () => {
    // If the stylesheet is restructured this file silently passes on nothing;
    // say so instead.
    expect(themes().length).toBeGreaterThanOrEqual(5);
  });

  it('reads --rail-elev as a mix of the rail ink into the rail surface', () => {
    // The ratio below is computed from that formula, so the formula has to be
    // the one the stylesheet actually uses.
    expect(CSS).toMatch(
      /--rail-elev:\s*color-mix\(in srgb,\s*var\(--rail-ink\)\s*10%,\s*var\(--rail-surface\)\)/,
    );
  });

  it.each(themes().map((t) => [t.name, t] as const))(
    '%s keeps typed text legible on the field it is typed into',
    (_name, theme) => {
      const field = mix(theme.ink, theme.surface, 10);
      // AA for body text. The failure this replaces was not 4.4 — it was 1.0,
      // the same colour twice, so the bar is set where a human can read it
      // rather than where the old value nearly was.
      expect(ratio(rgb(theme.ink), field)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('actually binds that surface INSIDE the rail islands', () => {
    // THE ASSERTION THE REST OF THIS FILE DOES NOT MAKE. Everything above is
    // arithmetic on the token's definition, and arithmetic is just as true
    // when nothing uses it — checked by deleting the binding and watching the
    // suite pass. The bug was never the formula; it was that the islands
    // rebound the INK and left the SURFACE behind.
    //
    // Both of them: `.navtree[data-variant="sidebar"]` and `.sidenav`. The
    // second exists because `.sidenav-brand` is a sibling of the tree rather
    // than a child, and a rule that covered only the first left half the rail
    // on the app's tokens.
    const islands = [...TREE.matchAll(/--fg:\s*var\(--rail-ink\);/g)];
    expect(islands.length).toBeGreaterThanOrEqual(2);
    expect([...TREE.matchAll(/--bg-elev:\s*var\(--rail-elev\);/g)]).toHaveLength(islands.length);
  });

  it('keeps the field distinguishable from the rail behind it', () => {
    // A surface that cleared the contrast test by BEING the rail would pass
    // the rule above and lose the box.
    for (const theme of themes()) {
      expect(ratio(mix(theme.ink, theme.surface, 10), rgb(theme.surface))).toBeGreaterThan(1.05);
    }
  });
});
