import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * HOW TALL AN ask_user CARD IS ALLOWED TO BE.
 *
 * Reported with a screenshot of a three-question card: "option selector is too
 * big u gotta style it so it takes less vertical space".
 *
 * Measured in a browser against that exact card — 3 questions, 12 options, the
 * real stylesheet — it was **825px**. It is now **577px**, and nothing was
 * hidden to get there: no clamp, no truncation, no text that only exists in a
 * tooltip. These are the choices a reader is deciding between, and this is the
 * one surface in the product where saving space by hiding words costs the user
 * the decision instead of costing them a scroll.
 *
 * Three declarations do the work, which is why this is a CSS-contract test and
 * not a screenshot: a picture shows the card is shorter, only the rules say
 * whether the next person puts the height back by habit.
 */
const css = readFileSync(join(import.meta.dirname, 'ChatPane.css'), 'utf8');
const rule = (selector: string) =>
  new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
    css,
  )?.[1] ?? '';

describe('the ask_user card’s density', () => {
  it('runs the description INLINE after its label', () => {
    // The big one. A description on its own line costs a line per option even
    // when it is four words long; sharing the line costs nothing for a short
    // one and fewer wraps for a long one.
    expect(rule('.chat-question-option')).toContain('display: block');
    const inline = /\.chat-question-option-label,\s*\.chat-question-option-desc\s*\{([^}]*)\}/.exec(
      css,
    )?.[1];
    expect(inline).toContain('display: inline');
  });

  it('puts the separator in CSS, so an option with no description gets no stray dash', () => {
    expect(rule('.chat-question-option-desc::before')).toContain('content:');
    // Every "Other…" is exactly that option, and it is in every card.
    expect(rule('.chat-question-option-desc::before')).toMatch(/—/);
  });

  it('is wide enough to stop wrapping, and still inside the chat column', () => {
    const card = rule('.chat-question');
    const width = Number(/max-width:\s*(\d+)px/.exec(card)?.[1]);
    expect(width).toBeGreaterThanOrEqual(600);
    // The transcript column is 768px (.chat-list max-width) minus its padding.
    expect(width).toBeLessThanOrEqual(728);
  });

  it('NEVER hides option text — no clamp, no ellipsis, no hidden overflow', () => {
    // Measured: at this width a 2-line clamp bought exactly 0px on the card
    // that prompted the change. It can only ever cost information.
    const opt = rule('.chat-question-option');
    expect(opt).not.toContain('line-clamp');
    expect(opt).not.toContain('text-overflow');
    expect(opt).not.toContain('overflow: hidden');
  });

  it('keeps the paddings and gaps that were measured, not the ones that felt right', () => {
    expect(rule('.chat-question')).toContain('gap: 10px');
    expect(rule('.chat-question-options')).toContain('gap: 4px');
    expect(rule('.chat-question-option')).toContain('padding: 5px 10px');
  });
});
