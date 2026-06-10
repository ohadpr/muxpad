import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CursorScrollSession } from './cursor-scroll-session';

describe('CursorScrollSession', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores saved ratio once after replay idle', () => {
    localStorage.setItem('muxpad.paneScroll.v2', JSON.stringify({ p1: 0.5 }));
    const reveal = vi.fn();
    const session = new CursorScrollSession({
      paneId: 'p1',
      getForegroundCmd: () => 'cursor-agent',
      revealAfterReplay: reveal,
    });
    const scrollToLine = vi.fn();
    const scrollToBottom = vi.fn();
    const term = {
      buffer: { active: { baseY: 100 } },
      scrollToLine,
      scrollToBottom,
    };

    session.onTerminalWriteParsed(term as never);
    vi.advanceTimersByTime(400);

    expect(reveal).toHaveBeenCalledOnce();
    expect(session.replayActive).toBe(false);
    expect(scrollToLine).toHaveBeenCalledWith(50);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('does not clobber scroll when user scrolled up before replay fallback', () => {
    const reveal = vi.fn();
    const session = new CursorScrollSession({
      paneId: 'p1',
      getForegroundCmd: () => 'cursor-agent',
      revealAfterReplay: reveal,
    });
    const scrollToLine = vi.fn();
    const scrollToBottom = vi.fn();
    const term = {
      buffer: { active: { baseY: 100, viewportY: 70 } },
      scrollToLine,
      scrollToBottom,
    };

    session.armReplayFallback(term as never);
    session.onTerminalWriteParsed(term as never);
    vi.advanceTimersByTime(3000);

    expect(reveal).toHaveBeenCalledOnce();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it('does not restore scroll after skipReplay (WS reconnect)', () => {
    localStorage.setItem('muxpad.paneScroll.v2', JSON.stringify({ p1: 0.5 }));
    const session = new CursorScrollSession({
      paneId: 'p1',
      getForegroundCmd: () => 'cursor-agent',
      revealAfterReplay: vi.fn(),
    });
    const scrollToLine = vi.fn();
    session.skipReplay();
    session.onTerminalWriteParsed({ scrollToLine } as never);
    vi.advanceTimersByTime(1000);
    expect(scrollToLine).not.toHaveBeenCalled();
    expect(session.replayActive).toBe(false);
  });
});
