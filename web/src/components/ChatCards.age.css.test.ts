import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE AGE SITS ON THE RIGHT EDGE, AND THE VALUE GETS EVERYTHING ELSE.
 *
 * Both halves matter. `margin-left: auto` is what pins it to the container's
 * edge rather than letting it trail the value — so it never moves as the
 * content changes length, and the gap between them is slack the value can use.
 * `flex: 0 0 auto` is what stops it being squeezed or ellipsized when the value
 * is long, which on a 430px pane it always is.
 */
const css = readFileSync(join(__dirname, 'ChatCards.css'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? null : css.slice(i, css.indexOf('\n}', i));
};

describe('the card age', () => {
  it('is pushed to the container edge, not trailing the value', () => {
    expect(rule('.chat-card-age')).toContain('margin-left: auto');
  });

  it('never shrinks — the value is what gives way', () => {
    const r = rule('.chat-card-age') ?? '';
    expect(r).toMatch(/flex:\s*0 0 auto/);
    // …and the value is the one that can.
    expect(rule('.chat-card-value')).toMatch(/flex:\s*1 1 auto/);
    expect(rule('.chat-card-value')).toContain('min-width: 0');
  });

  it('keeps a gap so it cannot touch the value', () => {
    expect(rule('.chat-card-age')).toMatch(/padding-left:\s*\d+px/);
  });

  it('turns warm when the writer stopped, not red', () => {
    // Nothing is broken; something merely stopped arriving.
    expect(rule('.chat-card-age.-stale')).toContain('--status-working');
  });
});
