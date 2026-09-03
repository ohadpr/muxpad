import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANCHOR_SEEK_PAGE_BUDGET,
  type ChatScrollMem,
  SHOW_SETTLE_MS,
  SMOOTH_SCROLL_SETTLE_MS,
  firstVisibleRow,
  maxScrollTop,
  pinnedFromMemory,
  recallChatScroll,
  rememberChatScroll,
  scrollEventIsTrustworthy,
  scrollMemorySidMatches,
  scrollTopAfterOlderPrepend,
  scrollTopForAnchor,
  shouldPersistChatScroll,
} from './chat-scroll';

/** A remembered position, with the anchor fields defaulted. */
function memo(over: Partial<ChatScrollMem> = {}): ChatScrollMem {
  return { anchorId: null, anchorOffset: 0, ratio: 0.5, pinned: false, sid: null, ...over };
}

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
    expect(pinnedFromMemory(memo({ ratio: 0.3, pinned: false, sid: 's1' }))).toBe(false);
  });

  it('re-pins when memory says pinned', () => {
    expect(pinnedFromMemory(memo({ ratio: 1, pinned: true, sid: 's1' }))).toBe(true);
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
      rememberChatScroll('pane-x', memo({ ratio: 0, pinned: false, sid: 's1' }));
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

describe('firstVisibleRow — which message the reader is actually looking at', () => {
  // 10 rows, 100px each, stacked from y=0 in the container's own coordinates.
  const bottoms = (i: number) => (i + 1) * 100;

  it('picks the row straddling the viewport top', () => {
    expect(firstVisibleRow(10, bottoms, 250)).toBe(2); // row 2 spans 200..300
  });

  it('picks row 0 when nothing is scrolled past', () => {
    expect(firstVisibleRow(10, bottoms, 0)).toBe(0);
  });

  it('treats a row whose bottom is exactly on the line as already past', () => {
    // Row 2 ends at 300. At viewportTop 300 the reader sees row 3 first.
    expect(firstVisibleRow(10, bottoms, 300)).toBe(3);
  });

  it('returns `count` when every row is above the line (transient relayout)', () => {
    expect(firstVisibleRow(10, bottoms, 5000)).toBe(10);
  });

  it('is a binary search — it must not read every row', () => {
    // The capture runs off scroll events; a linear walk of getBoundingClientRect
    // over a few hundred rows would be a per-frame layout tax on a chat doing
    // nothing wrong.
    let reads = 0;
    const counted = (i: number) => {
      reads++;
      return bottoms(i);
    };
    firstVisibleRow(1024, counted, 51_200);
    expect(reads).toBeLessThanOrEqual(11); // log2(1024) + 1
  });
});

describe('scrollTopForAnchor — the reason this file no longer uses a ratio', () => {
  it('puts the anchored message back exactly where it was', () => {
    // The row has drifted 400px down (a prepended history batch); scrollTop has
    // to grow by exactly that to keep the message under the reader's eyes.
    expect(
      scrollTopForAnchor({
        scrollTop: 1000,
        rowTop: 380,
        anchorOffset: -20,
        scrollHeight: 9000,
        clientHeight: 600,
      }),
    ).toBe(1400);
  });

  it('is invariant to content APPENDED below — a ratio is not', () => {
    // The reader parked with message X 20px above the viewport top. The agent
    // then said 3000px more. The anchor says "don't move"; a ratio would push
    // the reader forward by R·3000.
    const scrollTop = 4000;
    const target = scrollTopForAnchor({
      scrollTop,
      rowTop: -20,
      anchorOffset: -20,
      scrollHeight: 15_000, // grew from 12_000, all of it below
      clientHeight: 600,
    });
    expect(target).toBe(scrollTop);
    const ratio = scrollTop / maxScrollTop(12_000, 600);
    expect(Math.round(ratio * maxScrollTop(15_000, 600))).not.toBe(scrollTop);
  });

  it('beats the ratio on the case that produced "it jumps back in history"', () => {
    // Reader at scrollTop 2000 of a 12_000px document (range 11_400, R≈0.175).
    // A 6000px batch of OLDER history prepends. The honest target is
    // 2000 + 6000 = 8000 — the same messages, pushed down.
    const beforeTop = 2000;
    const beforeRange = maxScrollTop(12_000, 600);
    const ratio = beforeTop / beforeRange;
    const grown = 6000;

    const anchored = scrollTopForAnchor({
      scrollTop: beforeTop,
      rowTop: grown - 30, // the row was 30px above the line; now it's grown-30 below
      anchorOffset: -30,
      scrollHeight: 12_000 + grown,
      clientHeight: 600,
    });
    expect(anchored).toBe(beforeTop + grown);

    // The ratio re-applied against the grown document lands 4900px EARLIER —
    // and because the restore loop re-applies it every frame, it overrides the
    // prepend compensation rather than losing to it.
    const byRatio = Math.round(ratio * maxScrollTop(12_000 + grown, 600));
    expect(byRatio).toBeLessThan(anchored);
    expect(anchored - byRatio).toBeGreaterThan(4000);
  });

  it('clamps into the scrollable range', () => {
    expect(
      scrollTopForAnchor({
        scrollTop: 100,
        rowTop: -9000,
        anchorOffset: 0,
        scrollHeight: 5000,
        clientHeight: 600,
      }),
    ).toBe(0);
    expect(
      scrollTopForAnchor({
        scrollTop: 100,
        rowTop: 9000,
        anchorOffset: 0,
        scrollHeight: 5000,
        clientHeight: 600,
      }),
    ).toBe(maxScrollTop(5000, 600));
  });
});

describe('the seek budget', () => {
  it('is bounded — a lost anchor must not drag a whole transcript over the wire', () => {
    // Each page is a socket round trip of up to 128 KB. A reader whose anchor
    // was lost (a /clear we didn't observe) must give up, not page forever.
    expect(ANCHOR_SEEK_PAGE_BUDGET).toBeGreaterThan(0);
    expect(ANCHOR_SEEK_PAGE_BUDGET).toBeLessThanOrEqual(16);
  });
});

describe('the remembered shape', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips an anchor', () => {
    rememberChatScroll('p1', memo({ anchorId: 'evt#3', anchorOffset: -42, ratio: 0.2 }));
    const got = recallChatScroll('p1');
    expect(got?.anchorId).toBe('evt#3');
    expect(got?.anchorOffset).toBe(-42);
  });

  it('normalises a junk offset instead of discarding a usable anchor', () => {
    rememberChatScroll('p2', {
      ...memo({ anchorId: 'evt#9' }),
      anchorOffset: Number.NaN,
    });
    const got = recallChatScroll('p2');
    expect(got?.anchorId).toBe('evt#9');
    expect(got?.anchorOffset).toBe(0);
  });

  it('still refuses an entry with no usable ratio at all', () => {
    rememberChatScroll('p3', { ...memo(), ratio: Number.NaN });
    expect(recallChatScroll('p3')).toBeNull();
  });
});
