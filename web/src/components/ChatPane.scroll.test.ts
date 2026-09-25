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
/** …and the same file with its prose removed, for assertions that a given
 *  SHAPE is absent: the notes in ChatPane.tsx name the shapes they replaced
 *  (`scrollTop += ΔscrollHeight`, `CSS.supports('overflow-anchor')`), so a
 *  naive search finds the comment explaining why the code is not there. */
const code = tsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

/*
 * `the settling restore retires a goal it could not reach` lived here: two tests
 * that asserted `ChatPane.tsx` CONTAINS the strings `retiredAnchorMemory({` and
 * `holdRememberedAnchor.current && !userScrolled.current`.
 *
 * Deleted with the code they named, and they are worth a note because they are
 * the clearest example in this tree of a test that cannot fail for the right
 * reason. Both passed throughout the week the retirement logic was shipping the
 * landing-point walk, because a substring is not a behaviour: the first would
 * have kept passing if the call had been made with the wrong arguments, at the
 * wrong time, or in a branch that never ran, and the second pinned the exact
 * boolean expression whose two-correct-rules composition WAS the bug.
 *
 * Nothing replaces them one-for-one. What replaces them in kind is
 * chat-scroll-intent.test.ts, which drives the state machine through the same
 * situations and asserts the outcome instead of the source text — and the
 * simulated-layout tests, which can express "the document changed under the
 * reader mid-seek", the case no string search and no jsdom assertion can reach.
 */

describe("the composer's reserve does not switch scroll anchoring off", () => {
  it('leaves .chat-list with a bottom padding nothing rewrites', () => {
    const pad = rule('.chat-list').padding?.split(/\s+/) ?? [];
    expect(px(pad[2])).toBe(0);
    // …and the component must not put one back inline.
    expect(code).not.toContain('paddingBottom: `${composerH');
  });

  it('keeps the scroller clear of a dynamic padding too', () => {
    expect(rule('.chat-scroll').padding).toBeUndefined();
    expect(rule('.chat-scroll')['padding-bottom']).toBeUndefined();
  });

  it('reserves the composer on a sibling row instead', () => {
    expect(tsx).toContain('className="chat-composer-reserve"');
    expect(tsx).toContain('`calc(${composerH + 14}px + var(--chat-keyboard-inset, 0px))`');
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

/**
 * WebKit has no scroll anchoring before Safari 27, so on every iPhone running
 * iOS 26 or earlier — Safari and the installed PWA alike, both WKWebView —
 * `overflow-anchor` is inert and a parked reader has NO owner for content
 * growing above them.
 *
 * Three tests here used to assert that ChatPane.tsx CONTAINED
 * `const keep = liveAnchor.current;`, a specific two-flag stand-down expression,
 * and `liveAnchor.current = here;`. All three named code that no longer exists,
 * and none of them could have failed for the right reason: a substring is not a
 * behaviour, so they would have kept passing with the call made at the wrong
 * time, with the wrong arguments, or in a branch that never ran.
 *
 * What replaces them is chat-scroll-controller.test.ts, where the whole ANCHORED
 * block runs twice under `describe.each` — once with the engine paying and once
 * with it paying nothing — plus a third case where it pays a FRACTION, which is
 * what was actually measured (1440 of 1920px in one frame) and which neither a
 * feature test nor a substring could have caught.
 *
 * What survives here is the part that genuinely is a property of this file: the
 * shapes that must never come back.
 */
describe('the compensation cannot take a form that double-pays', () => {
  it('never adds a height delta to scrollTop', () => {
    // `scrollTop += ΔscrollHeight` adds the growth a second time on an engine
    // that already paid — measured, the reader thrown forward by the same 450px
    // — and yanks a parked reader for growth BELOW them, which should move them
    // not at all.
    expect(code).not.toMatch(/scrollTop \+= /);
    const intent = readFileSync(join(__dirname, '../lib/chat-scroll-intent.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(intent).not.toMatch(/scrollTop \+= /);
  });

  it('never feature-tests for scroll anchoring', () => {
    // `CSS.supports('overflow-anchor', 'auto')` answers TRUE on an iOS 26
    // WKWebView that will not pay, and true on Playwright's WebKit that will, so
    // it cannot distinguish the two cases it would be asked to distinguish. The
    // double-pay defence is the arithmetic being absolute.
    expect(code).not.toContain("CSS.supports('overflow-anchor'");
  });
});

describe('the composer clears the software keyboard', () => {
  it('reads an inset that is 0 everywhere it is not set', () => {
    // Desktop, and every failure mode of the mobile effect, must resolve to the
    // layout that shipped.
    expect(rule('.chat-composer-wrap').bottom).toBe('var(--chat-keyboard-inset, 0px)');
  });

  it('reserves it in the log too, not just under the pill', () => {
    // The scroller's clientHeight does not change when iOS raises a keyboard,
    // so without this the last turns sit behind it.
    expect(tsx).toContain('var(--chat-keyboard-inset, 0px)');
    expect(tsx).toContain('isMobileLayout()');
  });
});
