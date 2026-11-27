import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TOUCH TARGETS ON THE PHONE, pinned rather than eyeballed.
 *
 * The back button measured 44×45 — clearing Apple's 44pt minimum — and was
 * still reported as hard to tap: "the back button at the top row in mobile,
 * the target for tapping is too small. I often find it hard to tap that back
 * button."
 *
 * Both halves of the fix are here because both are easy to undo by accident.
 * The BOX is what catches the thumb; the GLYPH is what the thumb aims at, and
 * a glyph centred in a 44px box that starts at x=0 sits 13px from the screen
 * edge — against the edge iOS itself watches for the interactive-pop gesture.
 */
const css = readFileSync(join(__dirname, 'MobileNav.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(join(__dirname, 'MobileNav.tsx'), 'utf8');

describe('the back button is reachable', () => {
  const rule = /\.mobile-chat-back\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('is wider than the 44pt floor, not merely at it', () => {
    const width = Number(/width:\s*(\d+)px/.exec(rule)?.[1] ?? 0);
    expect(width).toBeGreaterThanOrEqual(56);
  });

  it('still starts at the screen edge — no dead strip beside it', () => {
    // Insetting the BOX would be the obvious way to get the glyph off the
    // edge and the wrong one: it would make the leftmost pixels do nothing,
    // which is exactly where a thumb coming from the left arrives first.
    expect(rule).not.toMatch(/margin-left:\s*[1-9]/);
    expect(rule).toMatch(/justify-content:\s*center/);
  });

  it('the glyph is big enough to aim at', () => {
    const back = tsx.slice(tsx.indexOf('mobile-chat-back'));
    const size = Number(/<svg\s+width="(\d+)"/.exec(back)?.[1] ?? 0);
    expect(size).toBeGreaterThanOrEqual(20);
  });
});
