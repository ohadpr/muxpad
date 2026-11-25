import { describe, expect, it } from 'vitest';
import { CARD_CONTAINERS, measureCardSurface } from './card-frame';

/**
 * AN HTML CARD'S FRAME MUST NEVER BE HANDED `transparent`.
 *
 * A root element with a transparent background gives the canvas to the UA
 * default, which follows the BROWSER's colour-scheme preference — so a
 * machine set to dark renders every card as a black slab inside a light app.
 * That is the bug card-frame.ts was written for.
 *
 * It came back. The measurement was `closest('.chat-card')`, naming the one
 * container that existed; the cards PAGE put the same component in
 * `.cards-tile`, `closest` returned null, and the surface fell back to
 * transparent. Reported as "the background colour of the cards themselves got
 * messed up and it was very dark".
 *
 * So these pin the two halves: the known containers include both, and an
 * UNKNOWN container still gets a real colour rather than the UA's guess —
 * because a list of selectors is exactly the thing that goes stale when
 * somebody adds a third surface.
 */
const el = (cls: string, bg: string, child?: HTMLElement): HTMLElement => {
  const d = document.createElement('div');
  d.className = cls;
  d.style.backgroundColor = bg;
  if (child) d.appendChild(child);
  document.body.appendChild(d);
  return d;
};

describe('measureCardSurface', () => {
  it('knows both containers that exist today', () => {
    expect(CARD_CONTAINERS).toContain('.chat-card');
    expect(CARD_CONTAINERS).toContain('.cards-tile');
  });

  it('takes the colour off a chat card', () => {
    const slot = document.createElement('span');
    el('chat-card', 'rgb(10, 20, 30)', slot);
    expect(measureCardSurface(slot)).toBe('rgb(10, 20, 30)');
  });

  it('takes the colour off a cards-page tile — the case that regressed', () => {
    const slot = document.createElement('span');
    el('cards-tile', 'rgb(40, 50, 60)', slot);
    expect(measureCardSurface(slot)).toBe('rgb(40, 50, 60)');
  });

  it('finds a painted ancestor even in a container nobody listed', () => {
    // The guard that matters: a future surface must not silently reintroduce
    // the black slab just because it is missing from CARD_CONTAINERS.
    const slot = document.createElement('span');
    el('some-future-surface', 'rgb(1, 2, 3)', slot);
    expect(measureCardSurface(slot)).toBe('rgb(1, 2, 3)');
  });

  it('skips an unpainted wrapper and keeps walking', () => {
    const slot = document.createElement('span');
    const inner = document.createElement('div');
    inner.appendChild(slot);
    el('cards-tile', 'rgb(7, 8, 9)', inner);
    expect(measureCardSurface(slot)).toBe('rgb(7, 8, 9)');
  });

  it('answers null rather than transparent when nothing paints', () => {
    // Null lets the caller decide; returning the string 'transparent' is the
    // thing that caused the bug, so it is never produced here.
    expect(measureCardSurface(null)).toBeNull();
  });
});

describe('an archive tile, which paints nothing on purpose', () => {
  it('takes the colour it actually sits on, not its own transparency', () => {
    // `.cards-list.-archive .cards-tile` is `background: transparent` by
    // design — the group is dimmed. Trusting the container's own value there
    // would hand the frame `transparent` and bring the black slab back for
    // exactly the cards nobody is watching.
    const slot = document.createElement('span');
    const tile = document.createElement('div');
    tile.className = 'cards-tile';
    tile.style.backgroundColor = 'transparent';
    tile.appendChild(slot);
    const page = document.createElement('div');
    page.style.backgroundColor = 'rgb(246, 245, 251)';
    page.appendChild(tile);
    document.body.appendChild(page);
    expect(measureCardSurface(slot)).toBe('rgb(246, 245, 251)');
  });
});
