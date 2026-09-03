/**
 * Per-tab icons. A tab carries a single emoji `icon` shown in a fixed
 * leading column in the navigator — separate from its name, so the list
 * always has a consistent leading glyph (vs. emoji-in-name, which left
 * half the rows bare).
 *
 * A new tab starts with NO icon and the rail renders `fallbackTabIcon(tab.id)`
 * for it — derived from the id rather than stored, so it is stable per row and
 * mostly distinct across rows — until either the headline generator picks one
 * from what the chat is actually about (server/src/chat/headline.ts) or the
 * user picks one by hand from the full emoji keyboard. It is NOT
 * `DEFAULT_TAB_ICON`: one constant glyph down the whole column defeats the
 * point of having a column, which is why that constant is now reached only by
 * the unreachable index branches of the two pickers below.
 *
 * Tabs used to be born with a RANDOM icon from the list
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

/** A sensible fallback when a tab somehow has no icon set and no id to key
 *  one off. Prefer `fallbackTabIcon`, which is distinct per row. */
export const DEFAULT_TAB_ICON = '🗂️';

/**
 * Pick a random icon from the curated set.
 *
 * NO LONGER the new-tab default — a stored random icon is a meaningless one,
 * and worse, "the tab already has an icon" is what stops the generator writing
 * a real one, so a random default silently disabled the feature for every tab
 * ever created. Retained only for the historical emoji-in-name migration.
 *
 * The rail's stand-in for a tab with no icon is `fallbackTabIcon`, which is the
 * same idea done properly: distinct per row, but derived rather than stored, so
 * it can never be mistaken for a choice anybody made.
 */
export function randomTabIcon(): string {
  return TAB_ICONS[Math.floor(Math.random() * TAB_ICONS.length)] ?? DEFAULT_TAB_ICON;
}

/**
 * The glyph the rail draws for a tab that has no icon of its own.
 *
 * DERIVED FROM THE TAB'S ID, not constant, and that is the whole point. A tab
 * has no stored icon until the generator gives it one — and some tabs never
 * get one, because a terminal, a web view or a url pane produces no turns for
 * anything to be derived FROM. Rendering one shared default meant those rows
 * became an undifferentiated column of the same glyph, and finding a row by
 * its shape is the entire reason the icon column exists. A wall of identical
 * icons is strictly worse than a wall of arbitrary ones.
 *
 * So the fallback is arbitrary but STABLE and mostly distinct: the same tab
 * draws the same glyph on every render, on every device, across restarts,
 * with nothing written to the database. That last part is what makes it
 * better than the random icon it replaces — a stored random glyph is
 * indistinguishable from one the user picked, which is exactly the ambiguity
 * that made the old icons impossible to safely replace. A derived one is
 * unambiguously not a choice, so the generator is free to override it the
 * moment it has something real to say.
 *
 * Collisions are possible (fifty glyphs, and a busy install has a few dozen
 * tabs) and are not worth engineering away: the old random assignment had
 * exactly the same property, and any row that collides is a row whose real
 * icon is one accepted generation away.
 *
 * FNV-1a, because it needs to be stable across processes and languages, not
 * cryptographic.
 */
export function fallbackTabIcon(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // >>> 0 keeps it an unsigned 32-bit value; Math.imul does the mod-2^32
    // multiply that plain `*` would lose precision on.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return TAB_ICONS[hash % TAB_ICONS.length] ?? DEFAULT_TAB_ICON;
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
 * ─── Is this string exactly ONE emoji, and what is its canonical form? ────
 *
 * The gate between a cheap model and the one fixed-width cell at the head of
 * every nav row (server/src/chat/headline.ts). Anything that is not a single
 * glyph either overflows that cell or renders as text sitting where a picture
 * should be.
 *
 * It REJECTS rather than repairs: no trimming a two-emoji answer down to its
 * first, no lifting the emoji out of "🚀 deploy". A bad generation must never
 * overwrite a good value, and half of a bad generation is still a bad
 * generation. The one thing it normalises is PRESENTATION — see below — which
 * changes how a correct answer is drawn, not which answer it is.
 *
 * ─── Counting is grapheme-aware, not length-based ─────────────────────────
 *
 * That is the whole reason this exists rather than a `[...s].length === 1`:
 *
 *   - `👨‍👩‍👧‍👦` is SEVEN code points (four people joined by three ZWJs) and one
 *     emoji. A code-point test rejects it; a UTF-16 `.length` test sees 11.
 *   - `👍🏽` is two code points (thumb + skin tone) and one emoji.
 *   - `❤️` is two (heart + variation selector) and one emoji.
 *   - `🇮🇱` is two regional indicators and one emoji.
 *   - `👍👍` is two code points and TWO emoji, and must be rejected — which no
 *     code-point count can distinguish from the skin-tone case.
 *
 * `Intl.Segmenter` is the only thing in the platform that draws that line, so
 * it draws it. Its one known blind spot is recorded at the bottom.
 *
 * ─── What the single grapheme must then be ────────────────────────────────
 *
 * "One grapheme" also describes `a`, `7`, `é` and `:`, so:
 *
 *   1. A flag (regional-indicator pair) or a keycap (`1️⃣`) passes outright —
 *      neither base character is Extended_Pictographic, so both need naming.
 *   2. Otherwise every code point must come from the emoji alphabet:
 *      Extended_Pictographic, a skin-tone modifier, a ZWJ, or a VS16. That one
 *      rule rejects letters, digits, punctuation, whitespace, a lone skin-tone
 *      modifier (`🏽`, which is Emoji_Presentation but not pictographic),
 *      zero-width and bidi controls, and an emoji with a combining accent
 *      stuck on the end of it.
 *   3. Typographic marks are never icons: ™ © ® ‼ ⁉ are all
 *      Extended_Pictographic and all punctuation, and they are rejected
 *      whether or not a variation selector is attached.
 *
 * ─── Why it NORMALISES presentation instead of demanding a VS16 ───────────
 *
 * A first draft required either default emoji presentation or an explicit
 * VS16. That sounds like rule 3 and is not. Roughly a third of the glyphs a
 * model actually reaches for — ⚙ 🛠 🗂 🗝 ⏱ 👁 🖥 ✂ ✉ ☁ ⚠ ♻ ⚖ ❄ — are
 * Extended_Pictographic with TEXT presentation by default, and a model types
 * them bare far more often than with the selector. Under that rule those
 * answers were silently thrown away and the row kept its placeholder, forever,
 * for a reason the user could never see. And the rule did not even do its
 * stated job: `®️` sailed through it, so it was testing "did the model happen
 * to type U+FE0F" rather than "is this punctuation".
 *
 * So presentation is a formatting slip, like whitespace, repaired by appending
 * the VS16 — and rule 3 does the job rule 3 was for. Every icon this function
 * returns renders as a picture, so the rail is not half colour, half
 * monochrome.
 *
 * ─── The blind spot ───────────────────────────────────────────────────────
 *
 * Two unrelated emoji welded together with a ZWJ are ONE grapheme by
 * segmentation and TWO glyphs on screen, because no font ligates that pair;
 * an invalid regional-indicator pair draws as two letter tiles. Both pass.
 * Telling them from the real sequences needs Unicode's RGI list, which is a
 * data file that goes stale — and neither is a shape a model produces, since a
 * ZWJ between unrelated emoji is not something anyone types by accident.
 * Recorded rather than defended.
 */
const SINGLE_FLAG = new RegExp(`^(?:${FLAG})$`, 'u');
const SINGLE_KEYCAP = new RegExp(`^(?:${KEYCAP})$`, 'u');
const HAS_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/**
 * The emoji alphabet, and nothing else. Anything outside it — a letter, a
 * digit, a space, a combining accent, a zero-width space, an RTL override —
 * makes the grapheme something other than an emoji.
 */
const EMOJI_ALPHABET_ONLY = new RegExp(
  `^(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|${ZWJ}|${VS16})+$`,
  'u',
);
/** Default-emoji presentation: no variation selector needed to draw it. */
const STARTS_EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
/**
 * Extended_Pictographic characters that are PUNCTUATION rather than pictures.
 * Rejected with or without a VS16 — a row labelled ® is not labelled.
 */
const TYPOGRAPHIC_MARKS = new Set(['™', '©', '®', '‼', '⁉']);
/** Escaped, like the regex fragments above — no invisible characters in the
 *  source. */
const VS16_CHAR = '\uFE0F';

/**
 * Longest input worth segmenting. A legitimate icon is at most a handful of
 * code points; anything larger is a sentence, and `Intl.Segmenter` should not
 * be pointed at a model's entire reply on the off-chance.
 */
const MAX_ICON_CHARS = 32;

/**
 * The canonical form of a one-emoji string, or null if it is not one.
 *
 * Canonical means "will be drawn as a picture": a text-presentation base gets
 * its VS16 appended. Everything else is returned exactly as given.
 */
export function normalizeTabIcon(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > MAX_ICON_CHARS) return null;
  // One grapheme cluster, or it is not one glyph. `Intl.Segmenter` has been in
  // Node since 16 and in every browser muxpad runs in; the guard is for an
  // exotic runtime, and its answer is "reject", never "guess".
  if (typeof Intl.Segmenter !== 'function') return null;
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  // Bounded by MAX_ICON_CHARS above, so materialising the clusters is a
  // handful of objects, not a scan of a model's whole reply.
  if ([...segmenter.segment(s)].length !== 1) return null;

  // Flags and keycaps have no pictographic base and are already canonical.
  if (SINGLE_FLAG.test(s) || SINGLE_KEYCAP.test(s)) return s;
  if (!HAS_PICTOGRAPHIC.test(s)) return null;
  if (!EMOJI_ALPHABET_ONLY.test(s)) return null;
  if (TYPOGRAPHIC_MARKS.has(String.fromCodePoint(s.codePointAt(0) ?? 0))) return null;
  if (s.includes(VS16_CHAR) || STARTS_EMOJI_PRESENTATION.test(s)) return s;
  return s + VS16_CHAR;
}

/** Predicate over `normalizeTabIcon`, for callers that only need the verdict. */
export function isSingleEmoji(raw: string): boolean {
  return normalizeTabIcon(raw) !== null;
}
