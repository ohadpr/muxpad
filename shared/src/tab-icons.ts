/**
 * Per-tab icons. A tab carries a single emoji `icon` shown in a fixed
 * leading column in the navigator — separate from its name, so the list
 * always has a consistent leading glyph (vs. emoji-in-name, which left
 * half the rows bare).
 *
 * A new tab starts with NO icon and the rail renders DEFAULT_TAB_ICON for it,
 * until either the headline generator picks one from what the chat is actually
 * about (server/src/chat/headline.ts) or the user picks one by hand from the
 * full emoji keyboard. Tabs used to be born with a RANDOM icon from the list
 * below, which is why several unrelated chats ended up all wearing 👍 and 🗝 —
 * and, worse, why none of them could ever be given a meaningful one: "this tab
 * already has an icon" is the generator's own hands-off signal.
 *
 * Curated set (not a full emoji keyboard): a spread that reads well at
 * 14px and covers the kinds of things a dev cockpit tab tends to be. Now used
 * only by the historical emoji-in-name migration and by the one-time backfill,
 * which treats membership of this list as "machine-assigned, safe to replace".
 */
export const TAB_ICONS: readonly string[] = [
  '🌐',
  '📝',
  '💻',
  '🖥️',
  '⚙️',
  '🔧',
  '🛠️',
  '🚀',
  '📦',
  '🐛',
  '🔌',
  '📊',
  '📈',
  '💾',
  '🗂️',
  '📁',
  '🔍',
  '🧪',
  '🧠',
  '💡',
  '⭐',
  '🔥',
  '✅',
  '🎯',
  '🗒️',
  '📡',
  '🔐',
  '🗝️',
  '🧩',
  '🎨',
  '🎮',
  '📚',
  '☁️',
  '🌙',
  '⚡',
  '🔭',
  '🧭',
  '🪐',
  '🛰️',
  '🤖',
  '👁️',
  '🦾',
  '🧰',
  '🔋',
  '🏗️',
  '🧱',
  '🌱',
  '🦊',
  '🐙',
  '🍿',
];

/** A sensible fallback when a tab somehow has no icon set. */
export const DEFAULT_TAB_ICON = '🗂️';

/**
 * Pick a random icon from the curated set.
 *
 * NO LONGER the new-tab default — a random icon is a meaningless one, and
 * because "the tab already has an icon" is exactly what stops the generator
 * writing a real one, a random default silently disabled the feature for every
 * tab ever created. Retained for the historical emoji-in-name migration only,
 * which runs against rows the one-time icon backfill then clears anyway.
 */
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

/**
 * ─── Is this string exactly ONE emoji? ────────────────────────────────────
 *
 * The gate on model-generated tab icons (server/src/chat/headline.ts). A tab's
 * icon occupies one fixed-width cell in the nav rail, and anything that is not
 * a single glyph either overflows that cell or renders as text sitting where a
 * picture should be. So this rejects rather than repairs: no trimming a
 * two-emoji answer down to its first, no stripping a trailing word. A bad
 * generation must never overwrite a good value, and half of a bad generation
 * is still a bad generation.
 *
 * COUNTING IS GRAPHEME-AWARE, NOT LENGTH-BASED, and that is the whole reason
 * this function exists rather than a `[...s].length === 1` test:
 *
 *   - `👨‍👩‍👧‍👦` is SEVEN code points (four people joined by three ZWJs) and one
 *     emoji. A code-point test rejects it; a UTF-16 `.length` test sees 11.
 *   - `👍🏽` is two code points (thumb + skin tone) and one emoji.
 *   - `❤️` is two (heart + variation selector) and one emoji.
 *   - `🇮🇱` is two regional indicators and one emoji.
 *   - `👍👍` is two code points and TWO emoji, and must be rejected — which no
 *     code-point count can distinguish from the skin-tone case.
 *
 * `Intl.Segmenter` is the only thing in the platform that draws that line
 * correctly, so it draws it.
 *
 * Four things are then required of the single grapheme, because "one grapheme"
 * on its own also describes `a`, `7`, `é` and `:` :
 *
 *   1. A flag (regional-indicator pair) or a keycap (`1️⃣`) passes outright —
 *      neither base character is Extended_Pictographic, so both need naming.
 *   2. Otherwise it must contain an Extended_Pictographic code point. This is
 *      what rejects letters, digits, punctuation, and a lone skin-tone
 *      modifier (`🏽`, which is Emoji_Presentation but not pictographic).
 *   3. It must actually RENDER as a picture: either its base has emoji
 *      presentation by default, or it carries an explicit VS16. Without this,
 *      `™`, `©`, `®` and `‼` — all Extended_Pictographic, all drawn as text —
 *      would land in the icon cell as punctuation. `®️` with its VS16 is a real
 *      emoji and still passes.
 *   4. No letters, digits or whitespace anywhere (keycaps excepted at step 1).
 *      Belt and braces behind the grapheme count.
 *
 * Empty, whitespace-only, `:-)`, `:)`, `<3` and any typed face fail at the
 * grapheme count — an ASCII emoticon is three graphemes, not one.
 */
const SINGLE_FLAG = new RegExp(`^(?:${FLAG})$`, 'u');
const SINGLE_KEYCAP = new RegExp(`^(?:${KEYCAP})$`, 'u');
const HAS_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const STARTS_EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
const HAS_TEXTUAL = /[\p{L}\p{N}\s]/u;
/** Escaped, like the regex fragments above — no invisible characters in the
 *  source. */
const VS16_CHAR = '\uFE0F';

/**
 * Longest input worth segmenting. A legitimate icon is at most a handful of
 * code points; anything larger is a sentence, and `Intl.Segmenter` should not
 * be pointed at a model's entire reply on the off-chance.
 */
const MAX_ICON_CHARS = 32;

export function isSingleEmoji(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > MAX_ICON_CHARS) return false;
  // One grapheme cluster, or it is not one glyph. `Intl.Segmenter` has been in
  // Node since 16 and in every browser muxpad runs in; the guard is for an
  // exotic runtime, and its answer is "reject", never "guess".
  if (typeof Intl.Segmenter !== 'function') return false;
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  // Bounded by MAX_ICON_CHARS above, so materialising the clusters is a
  // handful of objects, not a scan of a model's whole reply.
  if ([...segmenter.segment(s)].length !== 1) return false;

  if (SINGLE_FLAG.test(s) || SINGLE_KEYCAP.test(s)) return true;
  if (!HAS_PICTOGRAPHIC.test(s)) return false;
  if (!s.includes(VS16_CHAR) && !STARTS_EMOJI_PRESENTATION.test(s)) return false;
  if (HAS_TEXTUAL.test(s)) return false;
  return true;
}
