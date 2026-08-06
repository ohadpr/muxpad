import { describe, expect, it } from 'vitest';
import { consumePushFocusPane, setPushFocusPane } from './push-focus';

describe('push-focus store', () => {
  it('consumes the pending pane only for the matching tab, exactly once', () => {
    setPushFocusPane('tab-A', 'pane-X');
    // Wrong tab: nothing consumed, pending preserved.
    expect(consumePushFocusPane('tab-B')).toBeNull();
    // Right tab: returns the pane.
    expect(consumePushFocusPane('tab-A')).toBe('pane-X');
    // Consumed — a second read is empty.
    expect(consumePushFocusPane('tab-A')).toBeNull();
  });

  it('a newer set replaces an unconsumed pending', () => {
    setPushFocusPane('tab-A', 'pane-X');
    setPushFocusPane('tab-C', 'pane-Y');
    expect(consumePushFocusPane('tab-A')).toBeNull();
    expect(consumePushFocusPane('tab-C')).toBe('pane-Y');
  });
});
