import { beforeEach, describe, expect, it } from 'vitest';
import {
  SHOW_SETTLE_MS,
  SMOOTH_SCROLL_SETTLE_MS,
  maxScrollTop,
  pinnedFromMemory,
  recallChatScroll,
  rememberChatScroll,
  scrollEventIsTrustworthy,
  scrollMemorySidMatches,
  scrollTopAfterOlderPrepend,
  shouldPersistChatScroll,
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

describe('scrollEventIsTrustworthy — the pin-suppression window', () => {
  it('distrusts scroll events in the first moments after a pane is shown', () => {
    // Un-hiding from display:none delivers scroll events while layout is
    // still settling: clientHeight is back but scrollTop (and the composer's
    // height) are not. Acting on those used to unpin a visible chat and
    // PERSIST that — which is what made the bug sticky rather than a jump.
    const shownAt = 1_000;
    const until = shownAt + SHOW_SETTLE_MS;
    expect(scrollEventIsTrustworthy({ suppressedUntil: until, now: shownAt })).toBe(false);
    expect(scrollEventIsTrustworthy({ suppressedUntil: until, now: shownAt + 100 })).toBe(false);
  });

  it('trusts them again once the window has passed', () => {
    expect(scrollEventIsTrustworthy({ suppressedUntil: 1_250, now: 1_250 })).toBe(true);
    expect(scrollEventIsTrustworthy({ suppressedUntil: 1_250, now: 9_000 })).toBe(true);
  });

  it('trusts everything when nothing is in flight (0)', () => {
    // Also the shape a real gesture produces: the component zeroes the
    // deadline on wheel/touch so the reader is never second-guessed.
    expect(scrollEventIsTrustworthy({ suppressedUntil: 0, now: 0 })).toBe(true);
    expect(scrollEventIsTrustworthy({ suppressedUntil: 0, now: 5 })).toBe(true);
  });

  it('is wall-clock, not frame-counted — a throttled tab still converges', () => {
    // A background tab may deliver no frames at all; the window must still
    // close on time rather than staying open forever.
    expect(scrollEventIsTrustworthy({ suppressedUntil: 1_250, now: 60_000 })).toBe(true);
  });

  it('covers a smooth jump-to-bottom for longer than a show', () => {
    // A smooth glide emits an event per frame for a few hundred ms; each one
    // used to read as "the reader scrolled away from the target" and unpin
    // the chat the button had just pinned.
    expect(SMOOTH_SCROLL_SETTLE_MS).toBeGreaterThan(SHOW_SETTLE_MS);
    const until = 1_000 + SMOOTH_SCROLL_SETTLE_MS;
    expect(scrollEventIsTrustworthy({ suppressedUntil: until, now: 1_000 + SHOW_SETTLE_MS })).toBe(
      false,
    );
    expect(scrollEventIsTrustworthy({ suppressedUntil: until, now: until })).toBe(true);
  });
});

describe('scrollTopAfterOlderPrepend — clamping', () => {
  it('never returns a target outside the scrollable range', () => {
    // If clientHeight changed between capturing the anchor and applying it
    // (composer resize, viewport change), the raw arithmetic can overshoot.
    // The browser would clamp the real scrollTop while the caller stamped the
    // UNCLAMPED value as lastProgrammaticTop — so the next scroll event read
    // as "the reader took control" and unpinned them for no reason.
    const target = scrollTopAfterOlderPrepend({
      pinned: false,
      newScrollHeight: 1000,
      clientHeight: 900, // grew a lot since the anchor was taken
      anchorHeight: 200,
      anchorTop: 190,
    });
    expect(target).toBeLessThanOrEqual(maxScrollTop(1000, 900));
    expect(target).toBeGreaterThanOrEqual(0);
  });

  it('never returns a negative target', () => {
    const target = scrollTopAfterOlderPrepend({
      pinned: false,
      newScrollHeight: 500,
      clientHeight: 100,
      anchorHeight: 900,
      anchorTop: 0,
    });
    expect(target).toBe(0);
  });

  it('still preserves the reader’s anchor in the normal case', () => {
    // 400px of older content prepended: the message they were looking at
    // must stay under their eyes, i.e. scrollTop moves down by exactly that.
    expect(
      scrollTopAfterOlderPrepend({
        pinned: false,
        newScrollHeight: 1400,
        clientHeight: 500,
        anchorHeight: 1000,
        anchorTop: 120,
      }),
    ).toBe(520);
  });

  it('a pinned reader still lands exactly at the bottom', () => {
    expect(
      scrollTopAfterOlderPrepend({
        pinned: true,
        newScrollHeight: 1400,
        clientHeight: 500,
        anchorHeight: 1000,
        anchorTop: 120,
      }),
    ).toBe(900);
  });
});
