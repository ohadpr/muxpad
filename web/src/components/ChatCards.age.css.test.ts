import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE AGE SITS ON THE RIGHT EDGE, AND THE VALUE IS WHAT GIVES WAY.
 *
 * That property has survived a change of mechanism, which is why this file
 * tests it twice over. It used to be `margin-left: auto` on the age pushing
 * itself to the edge across a gap the value could grow into. Now the dotted
 * LEADER is a real element that takes the row's slack, so the age simply sits
 * after it — same result, no margin hack, and the gap is something you can see
 * rather than empty space.
 *
 * What must not change: the age is never squeezed or ellipsized, because it is
 * six characters and the value is a sentence; the value is the thing you can
 * open the card to finish reading.
 */
const css = readFileSync(join(__dirname, 'ChatCards.css'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? null : css.slice(i, css.indexOf('\n}', i));
};

describe('the card age', () => {
  it('sits at the container edge, with the leader holding the gap open', () => {
    // The leader is what reaches the edge; the age rides on the end of it.
    expect(rule('.chat-card-leader')).toMatch(/flex:\s*1 1 auto/);
    expect(rule('.chat-card-leader')).toMatch(/min-width:\s*\d+px/);
  });

  it('never shrinks — the value is what gives way', () => {
    const r = rule('.chat-card-age') ?? '';
    expect(r).toMatch(/flex:\s*0 0 auto/);
    // …and the value is the one that can. `0 1` not `1 1`: it is sized by its
    // content and only shrinks under real pressure, because the leader is what
    // fills the room.
    expect(rule('.chat-card-value')).toMatch(/flex:\s*0 1 auto/);
    expect(rule('.chat-card-value')).toContain('min-width: 0');
  });

  it('keeps a gap so it cannot touch the value', () => {
    expect(rule('.chat-card-age')).toMatch(/padding-left:\s*\d+px/);
  });

  it('turns warm when the writer stopped, not red', () => {
    // Nothing is broken; something merely stopped arriving.
    expect(rule('.chat-card-age.-stale')).toContain('--status-working');
  });

  it('and so does the card\u2019s edge, now there is no rail', () => {
    // The tape has no rail; the border carries it instead.
    expect(rule('.chat-card.-stale')).toContain('--status-working');
  });
});
