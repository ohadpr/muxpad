import { describe, expect, it } from 'vitest';
import { getCellDimensions, setScrollBarWidthZero } from './xterm-internals';

describe('xterm-internals', () => {
  it('returns null when terminal has no usable dims', () => {
    expect(getCellDimensions({} as never)).toBeNull();
  });

  it('reads from _core path on xterm v5', () => {
    const fake = { _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } } } as never;
    expect(getCellDimensions(fake)).toEqual({ width: 8, height: 16 });
  });

  it('returns null when width is 0 (cell not yet measured)', () => {
    const fake = { _core: { _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } } } } as never;
    expect(getCellDimensions(fake)).toBeNull();
  });

  it('setScrollBarWidthZero is a no-op when viewport is absent', () => {
    expect(() => setScrollBarWidthZero({} as never)).not.toThrow();
  });

  it('setScrollBarWidthZero zeros the viewport width when present', () => {
    const fake = { _core: { viewport: { scrollBarWidth: 14 } } };
    setScrollBarWidthZero(fake as never);
    expect(fake._core.viewport.scrollBarWidth).toBe(0);
  });
});
