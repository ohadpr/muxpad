import { describe, expect, it } from 'vitest';
import { cardColorScheme, parseRgb } from './card-frame';

/**
 * An html card is a sandboxed frame, and a transparent root hands its canvas to
 * the UA DEFAULT — which follows `color-scheme`. That was read from a variable
 * no theme defines, so it fell back to `light dark`, the UA took the BROWSER's
 * preference, and a laptop set to dark rendered every html card as a black slab
 * inside a light app.
 */

describe('reading a computed colour', () => {
  it('reads the ordinary rgb form', () => {
    expect(parseRgb('rgb(245, 244, 251)')).toEqual([245, 244, 251]);
    expect(parseRgb('rgba(26, 27, 38, 0.9)')).toEqual([26, 27, 38]);
  });

  it('reads the color(srgb …) form, which is 0-1 and NOT 0-255', () => {
    // What every color-mix() resolves to. Read as 0-255 a lavender card
    // measures as very nearly black, which is the same class of bug as the one
    // this file exists for.
    expect(parseRgb('color(srgb 0.91 0.89 0.97)')).toEqual([232, 227, 247]);
    expect(parseRgb('color(srgb 0.91 0.89 0.97 / 0.76)')).toEqual([232, 227, 247]);
  });

  it('reads hex, short and long', () => {
    expect(parseRgb('#1a1b26')).toEqual([26, 27, 38]);
    expect(parseRgb('#FFF')).toEqual([255, 255, 255]);
  });

  it('says it does not know rather than guessing', () => {
    expect(parseRgb('transparent')).toBeNull();
    expect(parseRgb('')).toBeNull();
    expect(parseRgb('rgb(nope)')).toBeNull();
  });
});

describe('which scheme the content should assume', () => {
  it('is dark on a dark card, whatever the laptop is set to', () => {
    expect(cardColorScheme('rgb(26, 27, 38)')).toBe('dark');
    expect(cardColorScheme('rgb(40, 42, 54)')).toBe('dark');
    expect(cardColorScheme('rgb(34, 21, 71)')).toBe('dark');
  });

  it('is light on a light card, whatever the laptop is set to', () => {
    // The reported bug, exactly: alucard's card surface, rendered black.
    expect(cardColorScheme('color(srgb 0.91 0.89 0.97)')).toBe('light');
    expect(cardColorScheme('rgb(255, 255, 255)')).toBe('light');
    expect(cardColorScheme('rgb(253, 246, 234)')).toBe('light');
  });

  it('falls back to letting the browser decide when it cannot read the colour', () => {
    // A colour this cannot parse is not a reason to assert the wrong one.
    expect(cardColorScheme('transparent')).toBe('light dark');
  });
});
