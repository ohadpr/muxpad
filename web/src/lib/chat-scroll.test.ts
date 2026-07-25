import { describe, expect, it, beforeEach } from 'vitest';
import {
  pinnedFromMemory,
  recallChatScroll,
  rememberChatScroll,
  shouldPersistChatScroll,
  scrollTopAfterOlderPrepend,
  maxScrollTop,
  scrollMemorySidMatches,
} from './chat-scroll';

describe('shouldPersistChatScroll', () => {
  it('refuses while the pane is inactive (face/tab hidden)', () => {
    expect(shouldPersistChatScroll({ active: false, clientHeight: 800 })).toBe(false);
  });

  it('refuses when display:none zeroes clientHeight — that would save ratio 0 / unpinned', () => {
    expect(shouldPersistChatScroll({ active: true, clientHeight: 0 })).toBe(false);
  });

  it('accepts a visible active scroll surface', () => {
    expect(shouldPersistChatScroll({ active: true, clientHeight: 600 })).toBe(true);
  });
});

describe('scrollTopAfterOlderPrepend', () => {
  it('stays pinned to the bottom when the reader was following new messages', () => {
    // newH=2000, clientH=500 → bottom is 1500
    expect(
      scrollTopAfterOlderPrepend({
        pinned: true,
        newScrollHeight: 2000,
        clientHeight: 500,
        anchorHeight: 800,
        anchorTop: 0,
      }),
    ).toBe(1500);
  });

  it('preserves the pre-prepend viewport when the reader had scrolled up', () => {
    // Old view: height 800, top 200. After prepend of 1200 bytes-worth → newH=2000.
    // Keep looking at the same messages: 2000 - 800 + 200 = 1400.
    expect(
      scrollTopAfterOlderPrepend({
        pinned: false,
        newScrollHeight: 2000,
        clientHeight: 500,
        anchorHeight: 800,
        anchorTop: 200,
      }),
    ).toBe(1400);
  });
});

describe('pinnedFromMemory', () => {
  it('defaults to pinned when nothing was remembered (fresh / other device)', () => {
    expect(pinnedFromMemory(null)).toBe(true);
  });

  it('honours an explicit unpinned memory', () => {
    expect(pinnedFromMemory({ ratio: 0.3, pinned: false, sid: 's1' })).toBe(false);
  });

  it('re-pins when memory says pinned', () => {
    expect(pinnedFromMemory({ ratio: 1, pinned: true, sid: 's1' })).toBe(true);
  });
});

describe('maxScrollTop', () => {
  it('returns the browser-clamped bottom offset', () => {
    expect(maxScrollTop(2000, 500)).toBe(1500);
    expect(maxScrollTop(400, 500)).toBe(0);
  });
});

describe('scrollMemorySidMatches', () => {
  it('allows restore when either sid is still unbound', () => {
    expect(scrollMemorySidMatches(null, 's1')).toBe(true);
    expect(scrollMemorySidMatches('s1', null)).toBe(true);
    expect(scrollMemorySidMatches(null, null)).toBe(true);
  });

  it('allows restore when both match', () => {
    expect(scrollMemorySidMatches('s1', 's1')).toBe(true);
  });

  it('blocks restore across a real sid rotation', () => {
    expect(scrollMemorySidMatches('old', 'new')).toBe(false);
  });
});

describe('rememberChatScroll hide corruption', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('does not treat a display:none zeroed scroll as a real reader position', () => {
    // Simulate the bug path: hide zeroes scrollTop + clientHeight, onScroll fires.
    // Persistence must be gated — if we remembered this, reopen would restore ratio 0.
    if (
      shouldPersistChatScroll({
        active: true,
        clientHeight: 0,
      })
    ) {
      rememberChatScroll('pane-x', { ratio: 0, pinned: false, sid: 's1' });
    }
    expect(recallChatScroll('pane-x')).toBeNull();
  });
});
