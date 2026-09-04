import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANCHOR_SEEK_PAGE_BUDGET,
  type ChatScrollMem,
  SHOW_SETTLE_MS,
  SMOOTH_SCROLL_SETTLE_MS,
  firstVisibleRow,
  maxScrollTop,
  opensAtNewest,
  readerIsCaughtUp,
  recallChatScroll,
  rememberChatScroll,
  scrollEventIsTrustworthy,
  scrollMemorySidMatches,
  scrollTopAfterOlderPrepend,
  scrollTopForAnchor,
  scrollTopForSearchHit,
  shouldPersistChatScroll,
  shouldRememberPosition,
} from './chat-scroll';

/** A remembered position, with the anchor fields defaulted. */
function memo(over: Partial<ChatScrollMem> = {}): ChatScrollMem {
  return { anchorId: null, anchorOffset: 0, ratio: 0.5, caughtUp: false, sid: null, ...over };
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

describe('opensAtNewest', () => {
  it('defaults to the newest message when nothing was remembered (fresh / other device)', () => {
    expect(opensAtNewest(null)).toBe(true);
  });

  it('honours a reader who had scrolled back past the newest message', () => {
    expect(opensAtNewest(memo({ ratio: 0.3, caughtUp: false, sid: 's1' }))).toBe(false);
  });

  it('opens at the newest message when the reader had read to the end', () => {
    expect(opensAtNewest(memo({ ratio: 1, caughtUp: true, sid: 's1' }))).toBe(true);
  });
});

describe('readerIsCaughtUp', () => {
  // The reported bug, in its smallest honest form.
  //
  // Geometry from the real component (1100×800 viewport, an ordinary chat):
  // sitting AT the bottom puts the newest message's top at 502 — it does not
  // reach the fold, because the floating composer reserves ~130px of list
  // padding beneath it. Nudge the wheel one notch (Chromium: ~120px) to re-read
  // the last line and the top moves to 622: still plainly on screen, still the
  // message being read — but 120 > the 40px live-follow threshold, so the old
  // code filed the reader under "parked in history" and anchored them to that
  // message forever. Nothing about that is visible until the agent talks; then
  // the anchor is faithfully restored thirty messages above the newest one.
  it('a one-notch nudge off the bottom is still CAUGHT UP', () => {
    expect(readerIsCaughtUp({ lastRowTop: 622, clientHeight: 800, nearBottom: false })).toBe(true);
  });

  it('resting at the bottom is caught up', () => {
    expect(readerIsCaughtUp({ lastRowTop: 502, clientHeight: 800, nearBottom: true })).toBe(true);
  });

  it('is caught up while reading a newest message taller than the viewport', () => {
    // Its top is AT the viewport top and it runs off the bottom: the reader has
    // scrolled back past nothing, so returning to its end is right.
    expect(readerIsCaughtUp({ lastRowTop: 0, clientHeight: 800, nearBottom: false })).toBe(true);
  });

  it('is NOT caught up once the newest message is off the bottom of the screen', () => {
    // One 400px wheel notch already does this — the reader can no longer see
    // the newest message, so they are reading history and keep their place.
    expect(readerIsCaughtUp({ lastRowTop: 902, clientHeight: 800, nearBottom: false })).toBe(false);
  });

  it('is NOT caught up when parked deep in older history', () => {
    expect(readerIsCaughtUp({ lastRowTop: 5200, clientHeight: 800, nearBottom: false })).toBe(
      false,
    );
  });

  it('falls back to the pin when there is nothing to measure', () => {
    // Empty chat, or a pane whose boxes collapsed under display:none.
    expect(readerIsCaughtUp({ lastRowTop: null, clientHeight: 800, nearBottom: true })).toBe(true);
    expect(readerIsCaughtUp({ lastRowTop: null, clientHeight: 0, nearBottom: false })).toBe(false);
  });
});

describe('the stored re-entry policy is not the live-follow pin', () => {
  // Two rounds of fixes went into the restore MECHANISM (visibility threading,
  // then anchoring to a message id instead of a scroll ratio) and the report
  // survived both, because the mechanism was never what was wrong: it restored
  // exactly what it was told to. What was wrong is that the thing it was told
  // came from `pinnedToBottom`, a 40px live-auto-scroll threshold, being reused
  // as the answer to a different question — where should re-opening this tab
  // land? This is the guard that the two are no longer the same value.
  it('a reader 120px off the bottom is unpinned for LIVE follow but caught up for RE-ENTRY', () => {
    const nearBottom = 120 < 40; // the component's live-follow test — false
    expect(nearBottom).toBe(false);
    const caughtUp = readerIsCaughtUp({ lastRowTop: 622, clientHeight: 800, nearBottom });
    expect(caughtUp).toBe(true);
    // …and "caught up" is what a re-open consults, so the newest message wins
    // over the message they happened to be nudged onto.
    expect(opensAtNewest(memo({ caughtUp, anchorId: 'e196', sid: 's1' }))).toBe(true);
  });

  it('still keeps a genuinely scrolled-back reader exactly where they were', () => {
    const caughtUp = readerIsCaughtUp({ lastRowTop: 5200, clientHeight: 800, nearBottom: false });
    expect(caughtUp).toBe(false);
    expect(opensAtNewest(memo({ caughtUp, anchorId: 'e170', sid: 's1' }))).toBe(false);
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
      rememberChatScroll('pane-x', memo({ ratio: 0, caughtUp: false, sid: 's1' }));
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

// ── The third case: an explicit destination ─────────────────────────────────
// A caught-up reader opens at the newest message; a scrolled-back reader keeps
// their exact spot. A SEARCH JUMP is neither — it is a place the user asked to
// be taken from somewhere else entirely, and it lands wherever the matched
// message happens to be. The rules below are what stop it from being mistaken
// for a reading position.

describe('shouldRememberPosition — a search jump is not a reading position', () => {
  it('records nothing while a jump is in flight', () => {
    expect(shouldRememberPosition({ searchJumpActive: true })).toBe(false);
  });

  it('records normally once the reader has taken the pane back', () => {
    expect(shouldRememberPosition({ searchJumpActive: false })).toBe(true);
  });
});

describe('a search jump does not poison the next ordinary open', () => {
  it('leaves a CAUGHT-UP reader caught up, however deep the jump landed', () => {
    // The reader had read to the end of pane-j and left.
    rememberChatScroll('pane-j', memo({ anchorId: null, ratio: 1, caughtUp: true, sid: 's1' }));

    // They search, follow a message hit, and land three weeks up the log. The
    // jump's own scrollTop writes fire onScroll like any other motion — each
    // one would record "parked at an ancient message, not caught up".
    for (const scrollTop of [0.05, 0.06, 0.07]) {
      if (shouldRememberPosition({ searchJumpActive: true })) {
        rememberChatScroll(
          'pane-j',
          memo({ anchorId: 'evt#ancient', ratio: scrollTop, caughtUp: false, sid: 's1' }),
        );
      }
    }

    // Tomorrow they click the tab, with no search involved. They must land at
    // the newest message, exactly as they would have without the search.
    const next = recallChatScroll('pane-j');
    expect(opensAtNewest(next)).toBe(true);
    expect(next?.anchorId).toBeNull();
    expect(next?.ratio).toBe(1);
  });

  it('leaves a SCROLLED-BACK reader on the message they had parked on', () => {
    // The other half: a jump must not overwrite a real parked spot either.
    rememberChatScroll(
      'pane-k',
      memo({ anchorId: 'evt#parked', anchorOffset: -120, ratio: 0.4, caughtUp: false, sid: 's1' }),
    );
    if (shouldRememberPosition({ searchJumpActive: true })) {
      rememberChatScroll('pane-k', memo({ anchorId: 'evt#hit', ratio: 0.01, sid: 's1' }));
    }
    const next = recallChatScroll('pane-k');
    expect(opensAtNewest(next)).toBe(false);
    expect(next?.anchorId).toBe('evt#parked');
    expect(next?.anchorOffset).toBe(-120);
  });

  it('starts recording again the moment the reader scrolls for themselves', () => {
    // The hold is released by a real gesture (see the wheel/touch listener in
    // ChatPane): from there this is an ordinary reader at an ordinary
    // position, and where they choose to be is exactly what the memory is for.
    rememberChatScroll('pane-l', memo({ ratio: 1, caughtUp: true, sid: 's1' }));
    const readerTookOver = false; // …then a wheel event cleared the hold
    if (shouldRememberPosition({ searchJumpActive: readerTookOver })) {
      rememberChatScroll(
        'pane-l',
        memo({ anchorId: 'evt#reading-here', ratio: 0.3, caughtUp: false, sid: 's1' }),
      );
    }
    const next = recallChatScroll('pane-l');
    expect(opensAtNewest(next)).toBe(false);
    expect(next?.anchorId).toBe('evt#reading-here');
  });

  it('writes nothing at all when there was no memory to protect', () => {
    // A jump into a chat this browser has never opened must not invent one:
    // the next ordinary open should still get the default (newest message).
    if (shouldRememberPosition({ searchJumpActive: true })) {
      rememberChatScroll('pane-m', memo({ anchorId: 'evt#hit', ratio: 0.02, caughtUp: false }));
    }
    expect(opensAtNewest(recallChatScroll('pane-m'))).toBe(true);
  });
});

describe('scrollTopForSearchHit — putting the matched run on screen', () => {
  const page = { scrollHeight: 10_000, clientHeight: 900 };

  it('parks the hit a third of the way down, leaving context above it', () => {
    // hitTop 600 means the mark is 600px below the viewport top right now;
    // it should end up at 300 (= 900/3), so scrollTop moves by +300.
    expect(scrollTopForSearchHit({ scrollTop: 4000, hitTop: 600, ...page })).toBe(4300);
  });

  it('scrolls UP for a hit above the viewport', () => {
    expect(scrollTopForSearchHit({ scrollTop: 4000, hitTop: -1000, ...page })).toBe(2700);
  });

  it('clamps at the top rather than going negative', () => {
    // A hit in the first message: the browser would clamp to 0 anyway, and an
    // unclamped target stamped as lastProgrammaticTop would make the very next
    // scroll event read as the reader taking control.
    expect(scrollTopForSearchHit({ scrollTop: 10, hitTop: -500, ...page })).toBe(0);
  });

  it('clamps at the bottom of the scrollable range', () => {
    expect(scrollTopForSearchHit({ scrollTop: 9000, hitTop: 5000, ...page })).toBe(
      maxScrollTop(page.scrollHeight, page.clientHeight),
    );
  });

  it('is a no-op when the hit already sits at the target line', () => {
    expect(scrollTopForSearchHit({ scrollTop: 4000, hitTop: 300, ...page })).toBe(4000);
  });
});
