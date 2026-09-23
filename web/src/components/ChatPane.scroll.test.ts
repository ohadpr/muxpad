import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The chat log's geometry where it touches the SCROLL POSITION.
 *
 * ─── Why a stylesheet test ───────────────────────────────────────────────
 * Everything in `lib/chat-scroll.ts` computes where `scrollTop` must land, and
 * every one of those answers assumes the same thing: that between measuring
 * the document and applying the answer, nothing else changed the height of the
 * content ABOVE the reader. A CSS rule can break that assumption without a
 * single line of that logic being wrong — and did.
 *
 * The older-history spinner was an ordinary in-flow child at the top of
 * `.chat-list`. Showing it grew the document by its own height above the
 * reader; the prepend compensation then measured `scrollHeight` WITH it and
 * applied the delta after `older-done` had already taken it away, so the
 * difference was silently deducted from the restore. Measured on the real
 * stack (Chromium, 300-turn transcript): a probe row sat 1044 px down the
 * viewport before a page of older history and 1090 px after it — the reader
 * pushed 46 px further back into history on every page, compounding all the
 * way up. `.chat-search-missed` carries the same note for the same reason; it
 * was made absolute after the same lesson.
 *
 * jsdom has no layout engine, so this is not a measurement — it is the
 * ARITHMETIC of the box, computed from the declarations, in the style of
 * NavTree.spacing.test.ts. A rule that starts taking flow space again changes
 * that arithmetic and fails here.
 */
// Comments stripped first: the notes in this stylesheet are prose, and prose
// is full of colons and semicolons the declaration parser below would read.
const css = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

/** The declarations of one rule, by exact selector. */
function rule(selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const body = css.slice(at + selector.length + 3, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

const px = (v: string | undefined): number => (v ? Number.parseFloat(v) : 0);

/**
 * How many pixels of FLOW this child of `.chat-list` costs — the number that
 * has to be zero for a box whose appearance and disappearance must not move
 * the reader. Out-of-flow boxes cost nothing; an in-flow one costs its own
 * height plus the flex gap it earns as one more child.
 */
function flowHeight(selector: string, contentHeight: number): number {
  const r = rule(selector);
  if (r.position === 'absolute' || r.position === 'fixed') return 0;
  const pad = r.padding?.split(/\s+/) ?? [];
  const padTop = px(pad[0]);
  const padBottom = px(pad[2] ?? pad[0]);
  return contentHeight + padTop + padBottom + px(rule('.chat-list').gap);
}

describe('the older-history spinner never moves the reader', () => {
  it('costs the document no height at all', () => {
    // 18px is the spinner glyph (.chat-load-earlier-spinner .chat-empty-spinner).
    // In flow this came to 46px: 4 + 18 + 2, plus .chat-list's 22px gap.
    expect(flowHeight('.chat-load-earlier-spinner', 18)).toBe(0);
  });

  it('resolves against .chat-list, so it rides with the log', () => {
    // Out of flow is only half of it: the box still has to land at the top of
    // the CONTENT (where the older history is arriving), not wherever the
    // nearest positioned ancestor happens to be — and `.chat-pane` is
    // positioned, so without this the spinner would pin to the viewport.
    expect(rule('.chat-list').position).toBe('relative');
    // And it has to still be a child of the list for that to mean anything —
    // moved up a level it would resolve against `.chat-pane` instead and stop
    // tracking the log.
    expect(tsx).toContain('className="chat-load-earlier-spinner"');
  });
});

/**
 * A SHAPE test, not a measurement — the call sites below live inside a
 * requestAnimationFrame loop that reads real geometry off a real scroller, and
 * jsdom has neither. The arithmetic each one performs is unit-tested where it
 * lives (`retiredAnchorMemory` in chat-scroll.test.ts); what cannot be reached
 * from there is whether the loop still CALLS it, and under which condition.
 * That is what these assert.
 */
describe('the settling restore retires a goal it could not reach', () => {
  it('hands the store the row it actually settled on', () => {
    // Without this the store keeps naming a message that is not coming back,
    // and `seekPages` is a local of the effect — so every visibility flip
    // spends another eight `load-older` round trips hunting the same ghost.
    expect(tsx).toContain('retiredAnchorMemory({');
  });

  it('only on a deadline expiry, never over a reader who took over', () => {
    // A gesture ends the loop too, and that reader writes their own memory
    // through onScroll. Retiring on that path would be this loop having the
    // last word over the reader, which is the bug the hold exists to prevent.
    expect(tsx).toContain('holdRememberedAnchor.current && !userScrolled.current');
  });
});

/**
 * The composer's reserve, and why it is a SIBLING.
 *
 * The browser's scroll anchoring is what holds an unpinned reader's place when
 * content above them changes height, and it has SUPPRESSION TRIGGERS: a
 * computed `padding` (or margin/width/height/top/…) change on the anchor node
 * or any of its ancestors UP TO AND INCLUDING the scrolling box cancels the
 * adjustment for that layout pass. `.chat-list` was that ancestor for every row
 * in the chat, and its `padding-bottom` was rewritten every time the composer's
 * measured height moved — typing, an attachment chip row, the "Reconnecting…"
 * banner, the mobile keyboard.
 *
 * Measured in headless Chromium (probe: /tmp/muxpad-hunt/fix-chat/
 * padding-probe.html), unpinned reader at scrollTop 2000, 480px of growth above
 * them:
 *
 *   no padding change        drift    0px   (engine paid the whole 480)
 *   .chat-list padding moves drift  480px   (suppressed; nothing else pays)
 *   .chat-scroll padding     drift  480px   (suppressed too — the scrolling box
 *                                            is IN the chain, so moving the
 *                                            reserve there fixes nothing)
 *   sibling row grows        drift    0px
 *
 * jsdom has no layout, so this is the declaration-level invariant that keeps
 * the reserve off the ancestor chain.
 */
describe("the composer's reserve does not switch scroll anchoring off", () => {
  it('leaves .chat-list with a bottom padding nothing rewrites', () => {
    const pad = rule('.chat-list').padding?.split(/\s+/) ?? [];
    expect(px(pad[2])).toBe(0);
    // …and the component must not put one back inline.
    expect(tsx).not.toContain('paddingBottom: `${composerH');
  });

  it('keeps the scroller clear of a dynamic padding too', () => {
    expect(rule('.chat-scroll').padding).toBeUndefined();
    expect(rule('.chat-scroll')['padding-bottom']).toBeUndefined();
  });

  it('reserves the composer on a sibling row instead', () => {
    expect(tsx).toContain('className="chat-composer-reserve"');
    expect(tsx).toContain('height: `${composerH + 14}px`');
    const r = rule('.chat-composer-reserve');
    // Cancels .chat-list's row gap, so the resting clearance is exactly the
    // height set inline — the same number the padding used to produce
    // (measured: 100px either way).
    expect(px(r['margin-top'])).toBe(-px(rule('.chat-list').gap));
    // It must stay out of the anchor scan: `anchorRows` takes direct children
    // of .chat-list that carry data-eid, so the reserve must carry none.
    expect(tsx).not.toMatch(/chat-composer-reserve"[\s\S]{0,200}data-eid/);
  });
});
