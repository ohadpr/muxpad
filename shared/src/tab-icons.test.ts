import { describe, expect, it } from 'vitest';
import { TAB_ICONS, isSingleEmoji, normalizeTabIcon, splitLeadingEmoji } from './tab-icons.js';

/**
 * The gate between a cheap model and the one fixed-width cell at the head of
 * every nav row.
 *
 * This is a TABLE, not a set of scenarios, because the whole risk in the
 * function is boundary cases in Unicode rather than logic — every interesting
 * failure is "a thing that is one emoji looked like several" or the reverse,
 * and the only way to be sure is to name them.
 */
describe('isSingleEmoji — exactly one emoji, grapheme-aware', () => {
  /**
   * Things that ARE one emoji. The important half: a false NEGATIVE here means
   * a perfectly good generation is thrown away and the row keeps the default
   * glyph, which is the quiet failure nobody notices.
   */
  const LEGAL: [string, string][] = [
    ['👍', 'a plain single-code-point emoji'],
    ['⚙', 'BARE text-presentation — the form a model actually types'],
    ['🛠', 'another bare one'],
    ['⏱', 'the glyph a cron tab is created with, bare'],
    ['☕', 'a BMP pictographic with default emoji presentation'],
    ['🚀', 'the obvious deploy glyph'],
    ['❤️', 'emoji + VS16 — two code points, one glyph'],
    ['🗂️', 'the default tab icon, which carries a VS16'],
    ['👁️', 'from the curated set, also VS16-bearing'],
    ['👨‍👩‍👧‍👦', 'a four-person ZWJ family — seven code points, ONE emoji'],
    ['🧑‍💻', 'a two-part ZWJ sequence'],
    ['🏳️‍🌈', 'ZWJ plus a variation selector'],
    ['👍🏽', 'base + skin-tone modifier'],
    ['👋🏿', 'a different skin tone'],
    ['🇮🇱', 'a flag — a regional-indicator PAIR, one glyph'],
    ['🇺🇸', 'another flag'],
    ['1️⃣', 'a keycap: digit + VS16 + enclosing keycap'],
    ['#️⃣', 'a hash keycap'],
  ];

  for (const [s, why] of LEGAL) {
    it(`accepts ${JSON.stringify(s)} — ${why}`, () => {
      expect(isSingleEmoji(s)).toBe(true);
    });
  }

  /**
   * Things that are NOT one emoji. A false positive here puts text, or two
   * glyphs, into a cell sized for one.
   */
  const ILLEGAL: [string, string][] = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['👍👍', 'TWO emoji — the case no code-point count can tell from a skin tone'],
    ['🙂🙃', 'two emoji, different'],
    ['🚀🔥', 'two emoji, the shape a model actually produces when it likes both'],
    ['a', 'a letter'],
    ['A', 'a capital letter'],
    ['é', 'a letter with a diacritic — one grapheme, still a letter'],
    ['7', 'a bare digit, without the keycap machinery'],
    [':-)', 'an ASCII emoticon — three graphemes'],
    [':)', 'the short emoticon'],
    ['<3', 'a typed heart'],
    ['🚀 deploy', 'emoji plus a word'],
    ['deploy 🚀', 'a word plus emoji'],
    ['🚀 🔥', 'two emoji with a space'],
    ['ICON: 🚀', 'the field label read back with its value'],
    ['KEEP', 'the sentinel'],
    ['emoji', 'the word'],
    ['™', 'Extended_Pictographic but TEXT presentation, no VS16'],
    ['©', 'same — a copyright sign is not an icon'],
    ['®️', 'a typographic mark is not an icon even WITH a VS16'],
    ['™️', 'nor is this one'],
    ['‼️', 'nor a double exclamation'],
    ['🚀\u0301', 'an emoji with a combining accent welded on'],
    ['🚀\u200B', 'an emoji with a zero-width space after it'],
    ['\u202E🚀', 'an emoji behind a right-to-left override'],
    ['🏽', 'a lone skin-tone modifier: Emoji_Presentation but not pictographic'],
    ['🇺', 'a single regional indicator — half a flag'],
    ['.', 'punctuation'],
    ['#', 'a hash without the keycap enclosure'],
    ['👍!', 'emoji plus punctuation'],
    ['"👍"', 'a quoted emoji — quotes are graphemes too'],
  ];

  for (const [s, why] of ILLEGAL) {
    it(`rejects ${JSON.stringify(s)} — ${why}`, () => {
      expect(isSingleEmoji(s)).toBe(false);
    });
  }

  it('tolerates surrounding whitespace, because that is a formatting slip', () => {
    // A model that emits "ICON:  🚀 " got the answer right and the spacing
    // wrong. Trimming a good answer is repair; trimming a BAD one (down to its
    // first emoji, say) would be salvage, and this function never does that.
    expect(isSingleEmoji(' 🚀 ')).toBe(true);
    expect(isSingleEmoji('\t🚀\n')).toBe(true);
    // …but trimming does not rescue two emoji.
    expect(isSingleEmoji(' 🚀 🔥 ')).toBe(false);
  });

  it('rejects a whole sentence without segmenting it', () => {
    // The length guard: an answer this long is not an emoji that needs
    // analysing, and Intl.Segmenter should not be pointed at a model's essay.
    const essay =
      'The icon for this conversation should probably be a rocket 🚀 because it is about deploys';
    expect(isSingleEmoji(essay)).toBe(false);
  });

  it('accepts every glyph in the curated set', () => {
    // TAB_ICONS is what the picker used to offer and what the backfill treats
    // as machine-assigned; if any member failed the validator, the two halves
    // of the feature would disagree about what a legal icon is.
    for (const icon of TAB_ICONS) expect(isSingleEmoji(icon)).toBe(true);
  });

  it('agrees with splitLeadingEmoji on what a leading glyph is', () => {
    // The two emoji-aware functions in this module must not drift: anything
    // splitLeadingEmoji is willing to lift out of a name is a glyph the icon
    // cell has to be able to hold.
    for (const name of ['👨‍👩‍👧‍👦 family budget', '🇮🇱 hebrew', '👍🏽 approvals', '❤️ health']) {
      const { icon } = splitLeadingEmoji(name);
      expect(icon).not.toBeNull();
      expect(isSingleEmoji(icon as string)).toBe(true);
    }
  });
});

describe('normalizeTabIcon — presentation is a formatting slip, not a wrong answer', () => {
  it('appends the VS16 a text-presentation base needs to be drawn as a picture', () => {
    // Roughly a third of the glyphs a model reaches for are text-presentation
    // by default and get typed bare. Rejecting them left the row on its
    // placeholder, silently, forever; repairing the presentation keeps the
    // answer and fixes only how it is drawn.
    for (const bare of ['⚙', '🛠', '🗂', '🗝', '⏱', '👁', '🖥', '✂', '✉', '☁', '⚠', '❄']) {
      expect(normalizeTabIcon(bare)).toBe(`${bare}\uFE0F`);
    }
  });

  it('leaves an already-canonical glyph exactly as it is', () => {
    for (const s of ['🚀', '☕', '❤️', '🗂️', '👨‍👩‍👧‍👦', '👍🏽', '🇮🇱', '1️⃣']) {
      expect(normalizeTabIcon(s)).toBe(s);
    }
  });

  it('is idempotent — normalising twice is normalising once', () => {
    for (const s of ['⚙', '🚀', '🗂️', '👨‍👩‍👧‍👦']) {
      const once = normalizeTabIcon(s) as string;
      expect(normalizeTabIcon(once)).toBe(once);
    }
  });

  it('makes the bare and VS16 spellings of one glyph compare equal', () => {
    // The reason the caller compares canonical forms: a model proposing a bare
    // ⚙ against a stored ⚙️ is agreeing, not changing its mind, and must not
    // spend the tab's one allowed icon change on a no-op.
    expect(normalizeTabIcon('⚙')).toBe(normalizeTabIcon('⚙️'));
  });

  it('returns null for everything the predicate rejects', () => {
    for (const bad of ['', 'x', '🚀🔥', ':-)', '™', '®️', '🏽']) {
      expect(normalizeTabIcon(bad)).toBeNull();
      expect(isSingleEmoji(bad)).toBe(false);
    }
  });
});
