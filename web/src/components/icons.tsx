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
      <path stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}
