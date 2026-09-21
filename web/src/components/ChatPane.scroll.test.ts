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
