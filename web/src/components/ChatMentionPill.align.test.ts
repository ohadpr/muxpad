import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WHERE THE INLINE CHIP SITS ON A LINE OF TEXT — and why this is a CSS test.
 *
 * The bug: a mention chip in a sent message sat visibly low, and in the composer
 * — a different line-height, and on mobile a different font-size — it sat wrong
 * by a different amount. Measured in Chromium against the components' real
 * markup, the chip's centre was 1.45px below the centre of the text's cap band
 * at 15.5px prose and 2.27px below it at 17.8px. An error that CHANGES with the
 * text size is the signature of an absolute offset, and there was one.
 *
 * ─── THE OFFSET THAT LOOKED LIKE THE CAUSE WAS INERT ─────────────────────────
 * `.chatchip[data-density="chip"] { vertical-align: -3px }` is the obvious
 * suspect and it did NOTHING. The chip's one `chip`-density use is inside
 * `.chat-mention-pill`, which is `display: inline-flex`, and `vertical-align`
 * does not apply to a flex item. Measured: setting it to `-20px` moved the chip
 * zero pixels. A magic number that is also dead code — so it is deleted rather
 * than scaled, and this file asserts it stays deleted, because re-adding it
 * would look like a fix and change nothing.
 *
 * ─── WHAT ACTUALLY POSITIONED THE PILL: THE EMOJI'S BASELINE ─────────────────
 * With `align-items: center` no flex item participates in baseline alignment, so
 * the engine takes the pill's baseline from its FIRST flex item — the tile —
 * whose own baseline comes from the 10px emoji inside it. So the pill was hung
 * on a text line by the baseline of a glyph in a box, which is why the offset was
 * ~4px whatever the surrounding text did: measured, the tile's bottom edge sat
 * exactly 4.00px below the prose baseline at 15.5px AND at 17.8px, while the cap
 * band it should have been centred on grew from 10.91px to 12.53px.
 *
 * The fix is `align-items: baseline` plus `align-self: center` on the tile. That
 * takes the tile out of baseline consideration and leaves the NAME — real text,
 * in the same family as the prose around it — as the pill's baseline. The pill
 * then hangs off the text's own metrics at every size, with no length anywhere.
 * Measured after: 0.23px at 15.5px, 0.66px at 17.8px, and identical under RTL.
 *
 * A stylesheet test rather than a rendering one because jsdom has no layout: the
 * numbers above come from Chromium (the harness is recorded in the commit), and
 * what this file can defend is the STRUCTURE those numbers depend on — that the
 * alignment is declared where it applies, and that no length creeps back in.
 */

const css = (p: string) => readFileSync(join(__dirname, p), 'utf8');
/** Strip comments — prose about a declaration is not a declaration. */
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const PICKER_CSS = bare(css('ChatMentionPicker.css'));
const CHIP_CSS = bare(css('ChatChip.css'));

/** The body of the first rule whose selector list matches `selector` exactly. */
function rule(sheet: string, selector: string): string {
  const m = [...sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(
    (x) => (x[1] ?? '').trim() === selector,
  );
  if (!m) throw new Error(`no rule for ${selector}`);
  return (m[2] ?? '').trim();
}

describe('the inline chip is aligned to the text, not to a pixel', () => {
  it('the pill takes its baseline from its TEXT, not from the tile', () => {
    // The whole fix, in one declaration. `center` here is what put the engine on
    // the tile's emoji baseline.
    expect(rule(PICKER_CSS, '.chat-mention-pill')).toMatch(/align-items:\s*baseline/);
  });

  it('…and the tile is still centred across it', () => {
    // Opting the tile OUT of baseline alignment is what leaves the name as the
    // pill's baseline source. Without this the tile would hang off the text
    // baseline by its own bottom edge, which is lower than before, not better.
    expect(rule(PICKER_CSS, '.chat-mention-pill > .chatchip')).toMatch(/align-self:\s*center/);
  });

  it('the pill declares no length to sit by', () => {
    const decl = rule(PICKER_CSS, '.chat-mention-pill');
    // `vertical-align` on the pill is legitimate (it IS an inline box) but only
    // as a keyword; a length here would be the same guess moved one element out.
    const va = decl.match(/vertical-align:\s*([^;]+)/)?.[1]?.trim();
    if (va !== undefined) expect(va).not.toMatch(/-?[\d.]+(px|rem|em|pt)/);
  });

  it('the chip density carries NO vertical-align at all', () => {
    // It cannot work there — the chip is a flex item wherever `chip` density is
    // used — so a declaration would be a fix that measurably does nothing.
    const decl = rule(CHIP_CSS, '.chatchip[data-density="chip"]');
    expect(decl).not.toMatch(/vertical-align/);
    // The rule still exists and still does its real job: size.
    expect(decl).toMatch(/--chatchip-size:/);
  });

  it('the density rules still differ in SIZE only', () => {
    // ChatChip.tsx's contract, and the thing that makes deleting the offset safe:
    // if a density ever grew a positioning declaration, the alignment would have
    // two owners again.
    for (const sel of ['.chatchip[data-density="card"]', '.chatchip[data-density="chip"]']) {
      const decl = rule(CHIP_CSS, sel);
      const props = [...decl.matchAll(/(^|;)\s*([a-z-]+)\s*:/g)].map((m) => m[2]);
      expect(props.every((p) => p?.startsWith('--chatchip-'))).toBe(true);
    }
  });
});
