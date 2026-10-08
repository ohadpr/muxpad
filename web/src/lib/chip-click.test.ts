import { describe, expect, it } from 'vitest';
import { chipClickSide } from './chat-draft';

/**
 * Where the caret goes when you click a mention chip.
 *
 * The chip is inert, so the browser puts the caret BEFORE it wherever you
 * click — both edges, measured. You could therefore never place the caret after
 * a mention, and Backspace before a chip eats what is before the chip, so the
 * only way to delete one was to clear the whole draft. Reported exactly that
 * way.
 */
const rect = { left: 100, width: 80 }; // spans 100–180, midpoint 140

describe('chipClickSide', () => {
  it('left half puts the caret before', () => {
    expect(chipClickSide(rect, 101)).toBe('before');
    expect(chipClickSide(rect, 139)).toBe('before');
  });

  it('right half puts it after — the half that was unreachable', () => {
    expect(chipClickSide(rect, 141)).toBe('after');
    expect(chipClickSide(rect, 179)).toBe('after');
  });

  it('the midpoint belongs to the left, so the rule has no gap', () => {
    expect(chipClickSide(rect, 140)).toBe('before');
  });

  it('works for a chip at the origin, and a narrow one', () => {
    expect(chipClickSide({ left: 0, width: 10 }, 2)).toBe('before');
    expect(chipClickSide({ left: 0, width: 10 }, 8)).toBe('after');
    expect(chipClickSide({ left: 50, width: 1 }, 50.4)).toBe('before');
    expect(chipClickSide({ left: 50, width: 1 }, 50.9)).toBe('after');
  });
});
