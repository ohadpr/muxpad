import { describe, expect, it, vi } from 'vitest';
import {
  areMouseEventsActive,
  getCellDimensions,
  isInkForegroundCmd,
  linesAboveBottom,
  linesAboveFromRatio,
  restoreLinesAboveBottom,
  scrollRatioFromTerm,
  scrollBufferByLines,
  setScrollBarWidthZero,
  shouldForwardWheelToPty,
  shouldScrollXtermBuffer,
  shouldTouchScrollBuffer,
  sgrWheelInput,
  scrollBufferWheel,
  wheelInputForPty,
} from './xterm-internals';

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

  it('shouldForwardWheelToPty is true on the alt screen (buffer.alternate API)', () => {
    const alt = { type: 'alternate', length: 10 };
    const term = { buffer: { active: alt, alternate: alt }, rows: 24 };
    expect(shouldForwardWheelToPty(term as never)).toBe(true);
  });

  it('shouldForwardWheelToPty is true when enable-mouse-events is set', () => {
    const el = document.createElement('div');
    el.classList.add('enable-mouse-events');
    const normal = { type: 'normal', length: 2 };
    const term = { element: el, buffer: { active: normal, alternate: {} }, rows: 24 };
    expect(shouldForwardWheelToPty(term as never)).toBe(true);
  });

  it('shouldForwardWheelToPty is false for normal scrollback shells', () => {
    const active = { type: 'normal', length: 100 };
    const term = { buffer: { active, alternate: {} }, rows: 24 };
    expect(shouldForwardWheelToPty(term as never)).toBe(false);
  });

  it('shouldForwardWheelToPty is false at a fresh shell prompt (no scrollback)', () => {
    const active = { type: 'normal', length: 2 };
    const term = { buffer: { active, alternate: {} }, rows: 24 };
    expect(shouldForwardWheelToPty(term as never)).toBe(false);
  });

  it('shouldScrollXtermBuffer for cursor-agent on normal scrollback', () => {
    const active = { type: 'normal', length: 100 };
    const term = { buffer: { active, alternate: {} }, rows: 24 };
    const fg = 'agent --use-system-ca /Users/x/.local/share/cursor-agent/versions/x/index.js';
    expect(shouldScrollXtermBuffer(term as never, fg)).toBe(true);
    expect(shouldForwardWheelToPty(term as never, fg)).toBe(false);
  });

  it('shouldTouchScrollBuffer on mobile normal buffer even without scrollback', () => {
    const active = { type: 'normal', length: 2 };
    const term = { buffer: { active, alternate: {} }, rows: 24 };
    expect(shouldTouchScrollBuffer(term as never, null, true)).toBe(true);
    expect(shouldTouchScrollBuffer(term as never, null, false)).toBe(false);
  });

  it('shouldTouchScrollBuffer false for alternate buffer on mobile (Claude)', () => {
    const active = { type: 'alternate', length: 24 };
    const term = { buffer: { active, alternate: active }, rows: 24 };
    expect(shouldTouchScrollBuffer(term as never, 'claude', true)).toBe(false);
  });

  it('shouldScrollXtermBuffer for cursor-agent without scrollback', () => {
    const active = { type: 'normal', length: 10 };
    const term = { buffer: { active, alternate: {} }, rows: 24 };
    const fg = '/usr/bin/cursor-agent';
    expect(shouldScrollXtermBuffer(term as never, fg)).toBe(true);
    expect(shouldForwardWheelToPty(term as never, fg)).toBe(false);
  });

  it('shouldScrollXtermBuffer is false for claude on normal scrollback', () => {
    const active = { type: 'normal', length: 100 };
    const term = { buffer: { active, alternate: {} }, rows: 24 };
    expect(shouldScrollXtermBuffer(term as never, 'node claude-code')).toBe(false);
    expect(shouldForwardWheelToPty(term as never, 'node claude-code')).toBe(true);
  });

  it('isInkForegroundCmd matches known Ink processes', () => {
    expect(isInkForegroundCmd('cursor-agent')).toBe(true);
    expect(
      isInkForegroundCmd(
        'agent --use-system-ca /Users/x/.local/share/cursor-agent/versions/x/index.js',
      ),
    ).toBe(true);
    expect(isInkForegroundCmd('node claude-code')).toBe(true);
    expect(isInkForegroundCmd('bash')).toBe(false);
  });

  it('wheelInputForPty uses Page keys without mouse reporting', () => {
    const term = { element: document.createElement('div'), buffer: { active: {} } };
    expect(wheelInputForPty(term as never, 5, 10, 60)).toBe('\x1b[6~'.repeat(2));
  });

  it('wheelInputForPty uses SGR for Ink foreground', () => {
    const term = { element: document.createElement('div'), buffer: { active: {} } };
    expect(wheelInputForPty(term as never, 5, 10, 60, 30, true)).toContain('\x1b[<65;5;10M');
  });

  it('linesAboveBottom measures offset from the live prompt', () => {
    const term = { buffer: { active: { viewportY: 30, baseY: 50 } } };
    expect(linesAboveBottom(term as never)).toBe(20);
  });

  it('restoreLinesAboveBottom scrolls to a saved offset', () => {
    const scrollToLine = vi.fn();
    const term = { buffer: { active: { baseY: 50 } }, scrollToLine };
    restoreLinesAboveBottom(term as never, 20);
    expect(scrollToLine).toHaveBeenCalledWith(30);
  });

  it('restoreLinesAboveBottom caps stale offsets to top of scrollback', () => {
    const scrollToLine = vi.fn();
    const scrollToBottom = vi.fn();
    const term = {
      buffer: { active: { baseY: 50 } },
      scrollToLine,
      scrollToBottom,
    };
    restoreLinesAboveBottom(term as never, 500);
    expect(scrollToLine).toHaveBeenCalledWith(0);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('scrollRatioFromTerm and linesAboveFromRatio round-trip proportionally', () => {
    const term = { buffer: { active: { viewportY: 30, baseY: 100 } } };
    const ratio = scrollRatioFromTerm(term as never);
    expect(ratio).toBeCloseTo(0.7);
    expect(linesAboveFromRatio(term as never, ratio)).toBe(70);
  });

  it('scrollBufferByLines steps the viewport', () => {
    const scrollToLine = vi.fn();
    const term = {
      buffer: { active: { type: 'normal', viewportY: 0, baseY: 200 } },
      rows: 24,
      scrollToLine,
    };
    expect(scrollBufferByLines(term as never, 3)).toBe(true);
    expect(scrollToLine).toHaveBeenCalledWith(3);
  });

  it('scrollBufferWheel snaps to bottom only on the final step toward baseY', () => {
    const scrollToBottom = vi.fn();
    const scrollToLine = vi.fn();
    const nearBottom = {
      rows: 49,
      buffer: { active: { type: 'normal', viewportY: 48, baseY: 50 } },
      scrollToBottom,
      scrollToLine,
      _core: { viewport: { getLinesScrolled: () => 3 } },
    };
    const e = { deltaY: 90, shiftKey: false } as WheelEvent;
    expect(scrollBufferWheel(nearBottom as never, e)).toBe(true);
    expect(scrollToBottom).toHaveBeenCalledOnce();
    expect(scrollToLine).not.toHaveBeenCalled();

    scrollToBottom.mockClear();
    scrollToLine.mockClear();
    const midScroll = {
      rows: 49,
      buffer: { active: { type: 'normal', viewportY: 30, baseY: 50 } },
      scrollToBottom,
      scrollToLine,
      _core: { viewport: { getLinesScrolled: () => 3 } },
    };
    expect(scrollBufferWheel(midScroll as never, e)).toBe(true);
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(scrollToLine).toHaveBeenCalledWith(33);
  });

  it('scrollBufferWheel steps normally when far from baseY', () => {
    const scrollToBottom = vi.fn();
    const scrollToLine = vi.fn();
    const term = {
      rows: 49,
      buffer: { active: { type: 'normal', viewportY: 0, baseY: 200 } },
      scrollToBottom,
      scrollToLine,
      _core: { viewport: { getLinesScrolled: () => 3 } },
    };
    const e = { deltaY: 90, shiftKey: false } as WheelEvent;
    expect(scrollBufferWheel(term as never, e)).toBe(true);
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(scrollToLine).toHaveBeenCalledWith(3);
  });

  it('sgrWheelInput encodes wheel-up and wheel-down', () => {
    expect(sgrWheelInput(5, 10, -60)).toContain('\x1b[<64;5;10M');
    expect(sgrWheelInput(5, 10, 60)).toContain('\x1b[<65;5;10M');
  });

  it('areMouseEventsActive reads coreMouseService', () => {
    expect(areMouseEventsActive({} as never)).toBe(false);
    const active = { _core: { coreMouseService: { areMouseEventsActive: true } } };
    expect(areMouseEventsActive(active as never)).toBe(true);
  });

  it('setScrollBarWidthZero zeros the viewport width when present', () => {
    const fake = { _core: { viewport: { scrollBarWidth: 14 } } };
    setScrollBarWidthZero(fake as never);
    expect(fake._core.viewport.scrollBarWidth).toBe(0);
  });
});
