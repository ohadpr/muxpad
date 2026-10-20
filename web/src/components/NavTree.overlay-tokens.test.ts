import { readFileSync } from 'node:fs';
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
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'NavTree.css'), 'utf8');

/** The custom properties a rule sets, by its selector's source text. */
function tokensOf(selector: RegExp): Set<string> {
  const match = CSS.match(new RegExp(`${selector.source}\\s*\\{(.*?)\\n\\}`, 's'));
  if (!match?.[1]) return new Set();
  return new Set([...match[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
}

const ISLAND = /\.navtree\[data-variant="sidebar"\]/;
const OVERLAYS =
  /\.navtree-menu,\s*\n\.settings-popover,\s*\n\.ws-settings__panel,\s*\n\.ws-settings__bar/;

describe('overlays rendered inside the rail', () => {
  it('finds both rules — this file is worthless if the selectors drift', () => {
    expect(tokensOf(ISLAND).size).toBeGreaterThan(5);
    expect(tokensOf(OVERLAYS).size).toBeGreaterThan(5);
  });

  it('gives back every token the island takes over', () => {
    const missing = [...tokensOf(ISLAND)].filter((t) => !tokensOf(OVERLAYS).has(t));
    expect(missing).toEqual([]);
  });

  it('restores the SURFACES, not just the ink', () => {
    // Named explicitly as well as covered by the property above, because this
    // is the pair that actually broke and a future reader deserves to see it.
    const overlays = tokensOf(OVERLAYS);
    expect(overlays.has('--bg-elev')).toBe(true);
    expect(overlays.has('--bg-hover')).toBe(true);
  });
});
