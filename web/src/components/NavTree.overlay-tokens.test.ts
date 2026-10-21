import { readFileSync } from 'node:fs';
import { readFileSync as _rf, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AN OVERLAY THAT OPENS INSIDE THE RAIL MUST LEAVE THE ISLAND COMPLETELY.
 *
 * The rail rebinds the app's tokens to its own so its contents read on a deep
 * surface. A popover rendered inside it — the settings menu, a row menu, the
 * workspace panel — is NOT rail-coloured: it paints itself on the pane's
 * surface, so it has to wear the pane's ink too. A rule already existed for
 * that, and it restored the INK half only.
 *
 * That was correct for exactly as long as the island rebound ink alone. The
 * moment `--bg-elev` became `--rail-elev` (so the rail's own search button
 * would stop being white-on-white), the settings popover started painting
 * itself on the rail's purple while keeping the pane's dark ink — 1.1:1, and
 * the Theme / Font size / Notifications labels vanished. The same invisibility
 * as before with the two halves swapped.
 *
 * So the assertion is not "--bg-elev is restored". It is the PROPERTY that
 * would have caught both: whatever the island rebinds, the escape rule gives
 * back. Add a token to the island and this fails until the overlays are told
 * about it.
 */
/** COMMENTS STRIPPED FIRST. These rules carry long explanations that NAME the
 *  tokens they discuss — `.sidenav`'s own comment mentions --bg-chrome in
 *  prose — and a regex over the raw text reads that as a declaration. The
 *  first version of this file did exactly that and reported a token as
 *  unrestored when nothing sets it. A test that greps source has to parse at
 *  least well enough to tell code from prose. */
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'NavTree.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The raw declaration block of a rule, by its selector's source text. */
function ruleBody(selector: RegExp): string {
  return CSS.match(new RegExp(`${selector.source}\\s*\\{(.*?)\\n\\}`, 's'))?.[1] ?? '';
}

/** The custom properties a rule sets, by its selector's source text. */
function tokensOf(selector: RegExp): Set<string> {
  const match = CSS.match(new RegExp(`${selector.source}\\s*\\{(.*?)\\n\\}`, 's'));
  if (!match?.[1]) return new Set();
  return new Set([...match[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
}

const ISLANDS = [
  /\.navtree\[data-variant="sidebar"\]/,
  // The rail's chrome is not all inside the tree — `.sidenav-brand` is a
  // SIBLING of it — so `.sidenav` rebinds the same tokens and needs the same
  // guarantees. Checking only the first left half the rail unexamined.
  /\.sidenav/,
];
const OVERLAYS = /\.navtree-menu/;

/** Class names any component actually renders. A selector in the escape rule
 *  that nothing renders is not protection, it is rot — and three of the four
 *  originally listed had become exactly that once WorkspaceSettings and the
 *  settings popover were replaced. */
const RENDERED = (() => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
})();

describe('overlays rendered inside the rail', () => {
  it('finds the rules — this file is worthless if the selectors drift', () => {
    for (const island of ISLANDS) expect(tokensOf(island).size).toBeGreaterThan(5);
    expect(tokensOf(OVERLAYS).size).toBeGreaterThan(5);
  });

  it('gives back every token EITHER island takes over', () => {
    const taken = new Set([...ISLANDS].flatMap((i) => [...tokensOf(i)]));
    const missing = [...taken].filter((t) => !tokensOf(OVERLAYS).has(t));
    expect(missing).toEqual([]);
  });

  it('restores them to the PANE family, not back to the rail', () => {
    // THE ASSERTION THE FIRST VERSION DID NOT MAKE. It checked that
    // `--bg-elev` was present in the escape rule and nothing about its value,
    // so swapping `var(--pane-elev)` for `var(--rail-elev)` — the precise
    // wrong-family pairing the rule exists to prevent — would have passed.
    const body = ruleBody(OVERLAYS);
    for (const [token, want] of [
      ['--bg-elev', '--pane-elev'],
      ['--bg-hover', '--pane-hover'],
      ['--fg', '--pane-ink'],
      ['--fg-dim', '--pane-ink-dim'],
      ['--border', '--pane-border'],
    ] as const) {
      expect(body).toMatch(new RegExp(`${token}:\\s*var\\(${want}\\)`));
    }
  });

  it('defines every pane alias it restores from', () => {
    // A restore to `var(--pane-elev)` is worth nothing if that token does not
    // exist: it would resolve to the inherited (rail) value and the rule would
    // silently do the opposite of its job.
    const styles = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
      'utf8',
    );
    for (const alias of ['--pane-elev', '--pane-hover', '--pane-ink', '--pane-border'])
      expect(styles).toMatch(new RegExp(`${alias}:`));
  });

  it('names only selectors something actually renders', () => {
    // `.settings-popover`, `.ws-settings__panel` and `.ws-settings__bar` all
    // outlived their components and sat here protecting nothing.
    for (const cls of OVERLAYS.source.split(',').map((c) => c.trim().replace(/^\\?\./, '')))
      expect(RENDERED).toContain(cls);
  });
});
