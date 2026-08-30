import { beforeEach, describe, expect, it } from 'vitest';
import { getPaneScrollRatio, setPaneScrollRatio } from './pane-scroll';

describe('pane-scroll', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips scroll ratio per pane', () => {
    setPaneScrollRatio('pane-a', 0.42);
    expect(getPaneScrollRatio('pane-a')).toBe(0.42);
    expect(getPaneScrollRatio('pane-b')).toBeUndefined();
  });

  it('clamps ratio to 0..1', () => {
    setPaneScrollRatio('pane-a', -0.5);
    expect(getPaneScrollRatio('pane-a')).toBe(0);
    setPaneScrollRatio('pane-a', 2);
    expect(getPaneScrollRatio('pane-a')).toBe(1);
  });

  it('ignores legacy absolute offsets from v1 storage', () => {
    localStorage.setItem('muxpad.paneScroll.v1', JSON.stringify({ 'pane-a': 500 }));
    expect(getPaneScrollRatio('pane-a')).toBeUndefined();
  });
});
