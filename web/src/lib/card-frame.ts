/**
 * What an html card's frame sits ON.
 *
 * ─── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────
 * An html card is a sandboxed iframe, and the injected stylesheet set
 * `html,body{background:transparent}` so the card's own surface would show
 * through. Per CSS, a root element with a transparent background hands the
 * canvas to the UA DEFAULT — and that default follows `color-scheme`, which was
 * being read from a `--card-scheme` variable no theme has ever defined. So it
 * fell back to `light dark`, the UA took the BROWSER's preference, and a
 * machine set to dark rendered every html card as a black slab inside a light
 * app. Measured on the running app: a progress bar on pure black in alucard.
 *
 * Transparent cannot be made to work here, so the frame is painted with the
 * card's own measured background instead — the exact resolved colour, taken off
 * the card element, which is the only way to stay correct through a theme
 * switch and through `color-mix` values that cannot be recomputed in JS.
 *
 * And the scheme follows that colour rather than the browser: a card in a dark
 * theme should give its content dark form controls and dark scrollbars, and a
 * card in a light theme light ones, whatever the laptop is set to.
 */

/** Red, green and blue in 0-255, from whatever `getComputedStyle` returned. */
export function parseRgb(color: string): [number, number, number] | null {
  const text = color.trim().toLowerCase();
  // `rgb(12, 13, 20)` / `rgba(12, 13, 20, 0.5)` — the common case.
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb?.[1]) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0] as number, parts[1] as number, parts[2] as number];
    }
    return null;
  }
  // `color(srgb 0.91 0.89 0.97 / 0.76)` — what a color-mix() resolves to, in
  // 0-1 components rather than 0-255. Reading these as 0-255 is how a lavender
  // card once measured as very nearly black.
  const fn = /^color\(srgb ([^)]+)\)$/.exec(text);
  if (fn?.[1]) {
    const parts = fn[1].split(/[\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [
        Math.round((parts[0] as number) * 255),
        Math.round((parts[1] as number) * 255),
        Math.round((parts[2] as number) * 255),
      ];
    }
    return null;
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex?.[1]) {
    const h = hex[1];
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }
  return null;
}

/**
 * Which scheme a card's content should assume, given the surface it is on.
 *
 * Unknown ⇒ `light dark`, the old behaviour: a colour this cannot read is not a
 * reason to assert the wrong one.
 */
export function cardColorScheme(surface: string): 'light' | 'dark' | 'light dark' {
  const rgb = parseRgb(surface);
  if (!rgb) return 'light dark';
  const [r, g, b] = rgb;
  // Relative luminance, the sRGB one. The threshold is the usual halfway point
  // — nothing in a theme lands near enough to it for the exact value to matter.
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance < 0.4 ? 'dark' : 'light';
}
