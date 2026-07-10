// Shared inline-SVG icons. Used wherever an icon needs to match the
// chrome's stroke language consistently — typographic glyphs like
// unicode × vary too much between fonts to look right next to + or ⚙.

// Default size 12px: matches the apparent glyph height of the chrome
// "+" buttons (which use font-size: 16px text whose cap-height is ~12px).
// Bump size at the call site when used inside a larger button or with a
// different surrounding type scale.
export function SvgClose({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      {/* Inset 2.25 (not 3): the drawn X spans ~62% of the nominal size.
          The old half-size span made every × read far smaller than
          same-`size` icons beside it (their strokes run nearly edge to
          edge of the viewbox). */}
      <path
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        d="M2.25 2.25l7.5 7.5M9.75 2.25l-7.5 7.5"
      />
    </svg>
  );
}
