import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(import.meta.dirname, 'ChatPane.css'), 'utf8');
/** Comments explain why it is gone and name it constantly; the question here
 *  is about DECLARATIONS. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * THE LOG DOES NOT SKIP LAYOUT FOR ROWS IT HAS NOT MEASURED.
 *
 * `content-visibility: auto` with `contain-intrinsic-size: auto 90px` was the
 * dominant cause of "scrolling up on mobile is chippy and buggy". `auto` only
 * remembers a row the browser has ALREADY rendered once, and scrolling UP is a
 * continuous supply of rows it never has — each resolving from the 90px guess
 * to its real height ABOVE the reader, carrying them with it.
 *
 * It hid for so long because scrolling DOWN never shows it: growth below
 * nobody is growth nobody feels. And the 202,971px check that was supposed to
 * guard it was taken on a chat whose rows had all been measured already, so it
 * could not fail.
 *
 * Measured over an identical flick sequence on a real chat:
 *
 *   390x844    on   40 jolted frames, worst 150px, 11,427px of growth
 *              off   0 jolted frames, worst   0px,      0px of growth
 *   1280x757   on   10 jolted frames, worst 142px,  1,669px of growth
 *              off   1 jolted frame,  worst  53px
 *
 * Mobile is worse only because the error scales with width: at 390px a message
 * wraps to 400-600px against a 90px guess. The defect is on both.
 *
 * If it comes back it must come back with a size that is RIGHT for an unseen
 * row at any width, which is a measurement nobody has, or scoped to rows BELOW
 * the reader, where being wrong costs nothing.
 */
describe('the chat log and content-visibility', () => {
  it('does not skip layout for log rows', () => {
    expect(CODE).not.toMatch(/content-visibility:\s*auto/);
  });

  it('declares no intrinsic-size guess for them either', () => {
    // The guess is the actual mechanism of the jank — a row is only displaced
    // by the difference between its guess and its truth.
    expect(CODE).not.toMatch(/contain-intrinsic-size/);
  });

  it('still explains why, so it is not reintroduced as an optimisation', () => {
    // The 31.4ms -> 10.9ms win was real and is worth knowing about before
    // somebody measures it again and puts it straight back.
    expect(CSS).toMatch(/content-visibility/);
    expect(CSS).toMatch(/chippy|jolted|scrolling up/i);
  });
});
