import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE CHAT'S NEW CHROME, MEASURED ON EVERY THEME THAT SHIPS.
 *
 * The pane grew a head and the composer grew a tool row, and both were first
 * written in `--chat-faint` because they are meant to be quiet. Measured, the
 * faint token sits at 2.10–3.30:1 on the composer's own surface — under AA on
 * all ten themes, for 12px labels and the only control that stops a running
 * turn. Quiet is a job for SHAPE and SIZE; it is not a job for an ink nobody
 * can read.
 *
 * This computes the ratios from the stylesheet rather than trusting the fix,
 * so a theme added later — or a token quietly re-pointed — fails here instead
 * of on somebody's screen.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, '..', 'styles.css'), 'utf8');
const CHAT = readFileSync(join(HERE, 'ChatPane.css'), 'utf8');
const TREE = readFileSync(join(HERE, 'NavTree.css'), 'utf8');

interface Theme {
  name: string;
  tokens: Record<string, string>;
}

function themes(): Theme[] {
  const out: Theme[] = [];
  for (const m of STYLES.matchAll(/\[data-theme="([^"]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = m;
    if (!name || !body) continue;
    const tokens: Record<string, string> = {};
    for (const t of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g))
      tokens[t[1] as string] = t[2] as string;
    if (tokens.bg && tokens['bg-elev'] && tokens.fg) out.push({ name, tokens });
  }
  return out;
}

const rgb = (hex: string): number[] => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
};
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]): number => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** `color-mix(in srgb, <a> P%, <b>)`. */
const mix = (a: string, b: string, pct: number): number[] =>
  rgb(a).map((v, i) => Math.round((v * pct) / 100 + (rgb(b)[i] as number) * (1 - pct / 100)));

/** The composer pill's own fill: `color-mix(--chat-elev 92%, --chat-fg)`. */
const pill = (t: Record<string, string>) => mix(t.fg as string, t['bg-elev'] as string, 8);

const ALL = themes();

describe('the composer tool row and the pane head', () => {
  it('finds the themes to check at all', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(5);
  });

  it('builds the pill from the tokens this test assumes', () => {
    // The arithmetic below is only true if the stylesheet still mixes the
    // surface this way.
    expect(CHAT).toMatch(
      /background:\s*color-mix\(in srgb,\s*var\(--chat-elev\)\s*92%,\s*var\(--chat-fg\)\)/,
    );
  });

  it.each(ALL.map((t) => [t.name, t] as const))(
    '%s keeps the tool labels readable on the pill',
    (_n, theme) => {
      // --chat-dim is what these wear; AA for 12px text.
      expect(
        ratio(rgb(theme.tokens['fg-dim'] as string), pill(theme.tokens)),
      ).toBeGreaterThanOrEqual(4.2);
    },
  );

  it('uses none of the faint token for chat text that has to be read', () => {
    // Comments stripped: three of these rules NAME --chat-faint to explain
    // why it is not the token being used.
    const flat = CHAT.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sel of [
      '.chat-tool-btn',
      '.chat-tools-hint',
      '.chat-head-ws',
      '.chat-turn-stop',
      '.chat-status-seg',
    ]) {
      const rest = flat.slice(flat.indexOf(`${sel} {`));
      const rule = rest.slice(0, rest.indexOf('}'));
      expect(rule, sel).not.toMatch(/color:\s*var\(--chat-faint\)/);
    }
  });
});

/**
 * THE RECENTLY-ACTIVE BAND, same treatment.
 *
 * An accent WASH was the first way to make it its own kind of thing, and it
 * does not survive ten themes: a tint only separates from the rail when the
 * accent's luminance differs from the rail's — on riso they are within
 * 1.04:1 — and at 13% it pushed tokyo-night's row ink under AA. A mix from
 * --fg always moves away from the surface, so the ground is that, and the
 * accent does the part a wash cannot: the seam, and the heading's ink.
 */
describe('the recently-active band, on every theme', () => {
  const rails = ALL.filter((t) => t.tokens['rail-surface'] && t.tokens['rail-ink-dim']);

  it('finds the rails to check at all', () => {
    expect(rails.length).toBeGreaterThanOrEqual(5);
  });

  it('builds its ground from the ink, not from the accent', () => {
    const flat = TREE.replace(/\/\*[\s\S]*?\*\//g, '');
    const rest = flat.slice(flat.indexOf('.navtree-workingset {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--fg\)\s*6%/);
    // …and the accent is the SEAM, which is the part a wash cannot do on a
    // theme whose accent and rail share a luminance.
    expect(rule).toMatch(/border-bottom:[^;]*--rail-accent/);
  });

  it.each(rails.map((t) => [t.name, t] as const))(
    '%s keeps its rows readable on the band',
    (_n, theme) => {
      const band = mix(theme.tokens.fg as string, theme.tokens['rail-surface'] as string, 6);
      expect(ratio(rgb(theme.tokens['rail-ink-dim'] as string), band)).toBeGreaterThanOrEqual(4.4);
    },
  );

  it.each(rails.map((t) => [t.name, t] as const))('%s draws a visible seam', (_n, theme) => {
    const band = mix(theme.tokens.fg as string, theme.tokens['rail-surface'] as string, 6);
    const accent = theme.tokens['rail-accent'] ?? theme.tokens.accent;
    if (!accent) return;
    const seam = rgb(accent).map((v, i) => Math.round(v * 0.45 + (band[i] as number) * 0.55));
    expect(ratio(seam, band)).toBeGreaterThan(1.3);
  });
});
