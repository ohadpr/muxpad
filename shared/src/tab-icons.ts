/**
 * Per-tab icons. A tab carries a single emoji `icon` shown in a fixed
 * leading column in the navigator — separate from its name, so the list
 * always has a consistent leading glyph (vs. emoji-in-name, which left
 * half the rows bare). New tabs get a random one; a picker lets the user
 * change it.
 *
 * Curated set (not a full emoji keyboard): a spread that reads well at
 * 14px and covers the kinds of things a dev cockpit tab tends to be.
 */
export const TAB_ICONS: readonly string[] = [
  '🌐', '📝', '💻', '🖥️', '⚙️', '🔧', '🛠️', '🚀', '📦', '🐛',
  '🔌', '📊', '📈', '💾', '🗂️', '📁', '🔍', '🧪', '🧠', '💡',
  '⭐', '🔥', '✅', '🎯', '🗒️', '📡', '🔐', '🗝️', '🧩', '🎨',
  '🎮', '📚', '☁️', '🌙', '⚡', '🔭', '🧭', '🪐', '🛰️', '🤖',
  '👁️', '🦾', '🧰', '🔋', '🏗️', '🧱', '🌱', '🦊', '🐙', '🍿',
];

/** A sensible fallback when a tab somehow has no icon set. */
export const DEFAULT_TAB_ICON = '🗂️';

/** Pick a random icon from the curated set (used as the new-tab default). */
export function randomTabIcon(): string {
  return TAB_ICONS[Math.floor(Math.random() * TAB_ICONS.length)] ?? DEFAULT_TAB_ICON;
}

// Variation selector / skin-tone / ZWJ — referenced by escape so no
// invisible characters live in the source regex.
const VS16 = '\\uFE0F';
const SKIN = '\\u{1F3FB}-\\u{1F3FF}';
const ZWJ = '\\u200D';
// A pictographic sequence: base glyph + optional variation selector,
// skin-tone modifier, and ZWJ-joined continuations.
const PICTO_SEQ = `\\p{Extended_Pictographic}(?:${VS16}|[${SKIN}]|${ZWJ}\\p{Extended_Pictographic}${VS16}?)*`;
// Flags are regional-indicator pairs; keycaps are digit/#/* + optional
// VS16 + the combining enclosing keycap (U+20E3). Neither base is
// Extended_Pictographic, so they need their own alternatives.
const FLAG = '\\p{Regional_Indicator}\\p{Regional_Indicator}';
const KEYCAP = `[0-9#*]${VS16}?\\u20E3`;
const LEADING_EMOJI = new RegExp(`^(${FLAG}|${KEYCAP}|${PICTO_SEQ})\\s*`, 'u');

/**
 * Split a leading emoji off a tab name. Used to migrate the historical
 * "emoji in the name" convention into the dedicated icon slot. Matches a
 * single leading pictographic plus any variation selector / skin-tone /
 * ZWJ-joined continuation, then swallows following whitespace.
 *
 * Returns the icon (or null if the name doesn't start with one) and the
 * remaining name.
 */
export function splitLeadingEmoji(name: string): { icon: string | null; rest: string } {
  const m = name.match(LEADING_EMOJI);
  if (!m) return { icon: null, rest: name };
  return { icon: m[1] ?? null, rest: name.slice(m[0].length) };
}
