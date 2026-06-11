import { describe, expect, it } from 'vitest';
import { quickSwitchIndex } from './use-tab-quickswitch.js';

describe('quickSwitchIndex', () => {
  it('maps a digit to the 0-based tab index', () => {
    expect(quickSwitchIndex(1, 5)).toBe(0);
    expect(quickSwitchIndex(3, 5)).toBe(2);
    expect(quickSwitchIndex(5, 5)).toBe(4);
  });

  it('returns null when the digit exceeds the tab count', () => {
    expect(quickSwitchIndex(4, 3)).toBeNull();
    expect(quickSwitchIndex(1, 0)).toBeNull();
  });

  it('caps at 9 tabs (10th+ are not quick-switchable)', () => {
    expect(quickSwitchIndex(9, 12)).toBe(8);
    expect(quickSwitchIndex(9, 5)).toBeNull();
  });
});
