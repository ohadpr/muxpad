import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  retiredAnchorMemory,
  scrollEventIsTrustworthy,
  scrollMotionIsTheReader,
  scrollMemorySidMatches,
  scrollTopAfterFoldChange,
  scrollTopAfterOlderPrepend,
  scrollTopForAnchor,
  scrollTopForSearchHit,
  shouldPersistChatScroll,
  shouldRememberPosition,
  shouldRestorePosition,
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
  // A 170px message: resting at the bottom puts its top at 502 and its END at
  // 672 — 128px clear of the fold, because the composer reserves that much list
  // padding beneath it.
  it('a one-notch nudge off the bottom is still CAUGHT UP', () => {
    // End moves 672 → 792: still on screen, still the message being read.
    expect(readerIsCaughtUp({ lastRowBottom: 792, clientHeight: 800, nearBottom: false })).toBe(
      true,
    );
  });

  it('resting at the bottom is caught up', () => {
    expect(readerIsCaughtUp({ lastRowBottom: 672, clientHeight: 800, nearBottom: true })).toBe(true);
  });

  // The regression this rule was rewritten for: "I come back to muxpad and it
  // scrolls to the very bottom instead of my last position."
  //
  // A Chat-mode reply with its action run folded above it — or an Agent-mode
  // tool result — runs to several screens. The rule used to ask whether the
  // newest message had STARTED on screen, so a reader on its first screen was
  // filed as caught up, and re-entry is defined as "open at the newest message":
  // they came back to the END of the thing they were halfway through.
  it('is NOT caught up on the first screen of a newest message taller than the viewport', () => {
    // 2400px message, its top at the viewport top: the end is 1600px away.
    expect(readerIsCaughtUp({ lastRowBottom: 2400, clientHeight: 800, nearBottom: false })).toBe(
      false,
    );
  });

  it('…and IS caught up once the reader reaches that message’s end', () => {
    expect(readerIsCaughtUp({ lastRowBottom: 790, clientHeight: 800, nearBottom: true })).toBe(true);
  });

  it('is NOT caught up once the newest message is off the bottom of the screen', () => {
    // One 400px wheel notch already does this — the reader can no longer see
    // the newest message, so they are reading history and keep their place.
    expect(readerIsCaughtUp({ lastRowBottom: 1072, clientHeight: 800, nearBottom: false })).toBe(
      false,
    );
  });

  it('is NOT caught up when parked deep in older history', () => {
    expect(readerIsCaughtUp({ lastRowBottom: 5370, clientHeight: 800, nearBottom: false })).toBe(
      false,
    );
  });

  it('falls back to the pin when there is nothing to measure', () => {
    // Empty chat, or a pane whose boxes collapsed under display:none.
    expect(readerIsCaughtUp({ lastRowBottom: null, clientHeight: 800, nearBottom: true })).toBe(
      true,
    );
    expect(readerIsCaughtUp({ lastRowBottom: null, clientHeight: 0, nearBottom: false })).toBe(
      false,
    );
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
    const caughtUp = readerIsCaughtUp({ lastRowBottom: 792, clientHeight: 800, nearBottom });
    expect(caughtUp).toBe(true);
    // …and "caught up" is what a re-open consults, so the newest message wins
    // over the message they happened to be nudged onto.
    expect(opensAtNewest(memo({ caughtUp, anchorId: 'e196', sid: 's1' }))).toBe(true);
  });

  it('still keeps a genuinely scrolled-back reader exactly where they were', () => {
    const caughtUp = readerIsCaughtUp({ lastRowBottom: 5370, clientHeight: 800, nearBottom: false });
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
  // The measured "comes back to the very bottom" case. A reader 1800px deep
  // inside a 3000px expanded action run parks there; `expandedGroups` is plain
  // component state, so a remount collapses that run to its 44px summary, and
  // the offset is replayed against a row 40x smaller.
  it('clamps an offset that no longer fits the row it names', () => {
    const collapsed = {
      scrollTop: 2620,
      rowTop: 0, // the collapsed run sits at the viewport top
      anchorOffset: -1800, // measured while it was 3000px tall
      scrollHeight: 5152,
      clientHeight: 700,
    };
    // Unclamped the target is 4420 — past the honest 2620, and the range clamp
    // then pins it to the bottom of the chat.
    expect(scrollTopForAnchor(collapsed)).toBe(4420);
    // Clamped to the row's real height, the reader lands on the run itself.
    expect(scrollTopForAnchor({ ...collapsed, rowHeight: 44 })).toBe(2620);
  });

  it('leaves an offset that still fits alone', () => {
    // The row did not change: the clamp must be inert, not merely harmless.
    expect(
      scrollTopForAnchor({
        scrollTop: 1000,
        rowTop: 380,
        anchorOffset: -20,
        scrollHeight: 9000,
        clientHeight: 600,
        rowHeight: 3000,
      }),
    ).toBe(1400);
  });

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

// ── …and the READ half of the same hold ─────────────────────────────────────
// `shouldRememberPosition` stops a jump WRITING the memory. That is only half
// a rule: something still READS it. The settling restore re-runs on every
// visibility transition (showEpoch) — an app backgrounding, a screen lock, a
// browser-tab switch — none of which is a gesture and none of which clears the
// jump (leaving the PANE does, which is why a tab switch was never the reported
// case). So it would re-assert a memory the jump had deliberately frozen, and
// the reader would be dragged out of the result they asked for and back into
// history at a moment they did nothing at all.
//
// Measured on the real stack before this rule existed: parked at message 147
// (scrollTop 8000), searched, landed on message 198 (scrollTop 22696),
// backgrounded and returned — scrollTop 8000, and the highlight gone too. A
// 14,696 px jump backwards, triggered by nothing the reader did. Verbatim the
// report: "muxpad keeps jumping back to scroll history randomly."

describe('shouldRestorePosition — a jump that owns the scroll is not overruled', () => {
  it('stands the restore down while a jump is in flight', () => {
    expect(shouldRestorePosition({ searchJumpActive: true })).toBe(false);
  });

  it('restores normally once the reader has taken the pane back', () => {
    expect(shouldRestorePosition({ searchJumpActive: false })).toBe(true);
  });

  it('agrees with the WRITE half for every state of the hold', () => {
    // The invariant, and the actual defect: these two are the read and write
    // ends of ONE store. Whenever the memory declines to record where the
    // reader is, the restore must decline to move them — otherwise the pane is
    // re-asserting a position it knows is stale. Relaxing either side alone
    // reopens the 14,696 px jump above.
    for (const searchJumpActive of [true, false]) {
      expect(shouldRestorePosition({ searchJumpActive })).toBe(
        shouldRememberPosition({ searchJumpActive }),
      );
    }
  });

  it('never applies a memory that describes the pre-search position', () => {
    // The scenario, end to end, in the units the store actually uses.
    // 1. The reader parks in history. This IS recorded — no jump yet.
    rememberChatScroll('pane-v', memo({ anchorId: 'evt#147', ratio: 0.2, caughtUp: false }));

    // 2. They search and land on a much later message. Every frame of the
    //    placement writes a scroll event; all of them are declined.
    const jumpHolds = true;
    if (shouldRememberPosition({ searchJumpActive: jumpHolds })) {
      rememberChatScroll('pane-v', memo({ anchorId: 'evt#198', ratio: 0.57 }));
    }

    // 3. The app is backgrounded and comes back. The restore re-runs — and the
    //    only memory it has is step 1's, which is 14,696 px from where the
    //    reader is now looking. It must not apply it.
    expect(shouldRestorePosition({ searchJumpActive: jumpHolds })).toBe(false);
    expect(recallChatScroll('pane-v')?.anchorId).toBe('evt#147'); // stale, as designed

    // 4. A wheel releases the hold: from here the reader is reading, the
    //    memory tracks them again, and the restore is ordinary again.
    expect(shouldRestorePosition({ searchJumpActive: false })).toBe(true);
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

// ── Round four: the store has to outlive the browsing context ───────────────
// "Whenever i open muxpad it resets my scroll position."
//
// Every earlier round returned to the chat through a door that keeps the tab
// alive — a tab switch, a background/foreground, a reload. sessionStorage
// survives all of those, so all of them passed. It does not survive OPENING
// THE APP, which is the only trigger the report ever named.

/** The key is deliberately NOT re-versioned: the tier changed, not the shape. */
const STORE_KEY = 'muxpad:chat-scroll:v4';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Wait out the 250 ms debounced write-through. */
const flushed = () => new Promise((r) => setTimeout(r, 320));

/** An entry as it sits in storage, with an explicit age. */
function stored(over: Partial<ChatScrollMem> & { at?: number } = {}) {
  return { ...memo(), at: Date.now(), ...over };
}

describe('remembered position across a cold open', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('survives a COLD OPEN — a new tab starts with NO sessionStorage', async () => {
    rememberChatScroll(
      'pane-cold',
      memo({ anchorId: 'evt#7', anchorOffset: -120, ratio: 0.31, caughtUp: false, sid: 's1' }),
    );
    await flushed();

    // The cold open. A relaunched PWA / reopened window gets a NEW browsing
    // context, whose sessionStorage is empty by specification; localStorage is
    // origin-scoped and is all that is left to restore from.
    sessionStorage.clear();
    vi.resetModules();
    const { recallChatScroll: recall } = await import('./chat-scroll');

    const got = recall('pane-cold');
    expect(got?.anchorId).toBe('evt#7');
    expect(got?.anchorOffset).toBe(-120);
    expect(got?.caughtUp).toBe(false);
  });

  it('adopts the sessionStorage era, so shipping the fix is not the LAST reset', async () => {
    // Exactly what the pre-fix build wrote: same key, same v4 shape, no `at`.
    sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        [
          'pane-legacy',
          { anchorId: 'evt#3', anchorOffset: -10, ratio: 0.4, caughtUp: false, sid: 's1' },
        ],
      ]),
    );
    vi.resetModules();
    const { recallChatScroll: recall, rememberChatScroll: remember } = await import(
      './chat-scroll'
    );

    expect(recall('pane-legacy')?.anchorId).toBe('evt#3');
    // Read-and-clear: once it is in the durable store, the session copy is only
    // a second source of truth.
    expect(sessionStorage.getItem(STORE_KEY)).toBeNull();

    // …and it is carried forward into localStorage on the next write, so the
    // NEXT cold open still has it.
    remember('pane-other', memo());
    await flushed();
    expect(localStorage.getItem(STORE_KEY)).toContain('pane-legacy');
  });

  it('prefers what localStorage already knows over a stale session copy', async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([['p', stored({ anchorId: 'new' })]]));
    sessionStorage.setItem(STORE_KEY, JSON.stringify([['p', memo({ anchorId: 'old' })]]));
    vi.resetModules();
    const { recallChatScroll: recall } = await import('./chat-scroll');
    expect(recall('p')?.anchorId).toBe('new');
  });

  it('a fresh browser profile has nothing, and opens at the newest message', async () => {
    // The boundary: no memory is not a reset, it is the correct default.
    vi.resetModules();
    const { recallChatScroll: recall, opensAtNewest: newest } = await import('./chat-scroll');
    expect(recall('never-seen')).toBeNull();
    expect(newest(recall('never-seen'))).toBe(true);
  });
});

describe('staleness — localStorage does not clean up after itself', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('forgets a position older than the cutoff', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        ['pane-ancient', stored({ anchorId: 'evt#1', at: Date.now() - 15 * DAY_MS })],
      ]),
    );
    vi.resetModules();
    const { recallChatScroll: recall } = await import('./chat-scroll');
    expect(recall('pane-ancient')).toBeNull();
  });

  it('degrades a stale entry to the NEWEST message, never to a wrong position', async () => {
    // The property that matters. `caughtUp: false` + an anchor is "parked in
    // history"; expiring it must not leave a half-honoured memory that parks
    // the reader somewhere arbitrary.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        [
          'pane-ancient',
          stored({ anchorId: 'evt#1', caughtUp: false, at: Date.now() - 60 * DAY_MS }),
        ],
      ]),
    );
    vi.resetModules();
    const { recallChatScroll: recall, opensAtNewest: newest } = await import('./chat-scroll');
    expect(newest(recall('pane-ancient'))).toBe(true);
  });

  it('keeps a position from within the cutoff', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['pane-recent', stored({ anchorId: 'evt#2', at: Date.now() - 3 * DAY_MS })]]),
    );
    vi.resetModules();
    const { recallChatScroll: recall } = await import('./chat-scroll');
    expect(recall('pane-recent')?.anchorId).toBe('evt#2');
  });

  it('expires on READ too — a cockpit window stays open for days', async () => {
    vi.resetModules();
    const { recallChatScroll: recall, rememberChatScroll: remember } = await import(
      './chat-scroll'
    );
    remember('pane-live', memo({ anchorId: 'evt#5' }));
    expect(recall('pane-live')?.anchorId).toBe('evt#5');
    // Time passes without the module ever re-initialising.
    vi.setSystemTime(Date.now() + 15 * DAY_MS);
    try {
      expect(recall('pane-live')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops one corrupt entry rather than the reader’s whole store', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['good', stored({ anchorId: 'evt#9' })], ['bad', null], 'not-an-entry']),
    );
    vi.resetModules();
    const { recallChatScroll: recall } = await import('./chat-scroll');
    expect(recall('good')?.anchorId).toBe('evt#9');
    expect(recall('bad')).toBeNull();
  });
});

describe('two muxpad windows share one localStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('does not delete a pane the OTHER window remembers', async () => {
    // Each window serialises its WHOLE map, so a naive write would forget
    // panes it has simply never opened. That is not last-writer-wins, it is
    // one window forgetting on another's behalf.
    const { rememberChatScroll: remember } = await import('./chat-scroll');
    remember('pane-mine', memo({ anchorId: 'mine' }));
    // The other window — already running, so this never passed through our
    // module init — flushes its own map before our debounce fires.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['pane-theirs', stored({ anchorId: 'theirs' })]]),
    );
    await flushed();

    const ids = (JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as [string, unknown][]).map(
      ([id]) => id,
    );
    expect(ids).toContain('pane-mine');
    expect(ids).toContain('pane-theirs');
  });

  it('lets the last writer win for a pane BOTH windows have open', async () => {
    // Deliberate. Two windows are two places the same reader was; both answers
    // are a position they actually occupied, so the loser costs a scroll, not a
    // wrong belief about where they were.
    const { rememberChatScroll: remember, recallChatScroll: recall } = await import(
      './chat-scroll'
    );
    remember('shared', memo({ anchorId: 'first' }));
    remember('shared', memo({ anchorId: 'second' }));
    await flushed();
    expect(recall('shared')?.anchorId).toBe('second');
    expect(localStorage.getItem(STORE_KEY)).toContain('second');
  });
});

describe('storage that refuses to store', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('degrades to memory-only on quota / private mode', async () => {
    const { rememberChatScroll: remember, recallChatScroll: recall } = await import(
      './chat-scroll'
    );
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      remember('pane-q', memo({ anchorId: 'evt#4' }));
      await flushed();
      // The write failed; this session still remembers, which is exactly what
      // sessionStorage-era code promised too.
      expect(recall('pane-q')?.anchorId).toBe('evt#4');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('scrollTopAfterFoldChange — a run that closes above the reader', () => {
  // The numbers are the live repro, Chromium against a 300-turn transcript: a
  // search landed inside a collapsed action run, which ChatPane force-opened
  // to 456px around the highlight. The reader scrolled 1200px onward, the hit
  // left the top of the screen, the IntersectionObserver dismissed it — and
  // the run snapped shut from ABOVE them. A probe row went from +682 to −948
  // where −518 was the honest answer, with scrollHeight falling 26898 → 26468.
  // The 430px gap IS the collapse, and nothing was paying for it.
  const COLLAPSE = 430;

  it('gives back exactly the height the collapse took', () => {
    // After the collapse the anchored row sits COLLAPSE px higher than the
    // reader left it; the target pulls scrollTop back by the same amount.
    expect(
      scrollTopAfterFoldChange({
        pinned: false,
        anchorRowTop: 200 - COLLAPSE,
        anchorOffset: 200,
        scrollTop: 23071,
        scrollHeight: 26468,
        clientHeight: 684,
      }),
    ).toBe(23071 - COLLAPSE);
  });

  it('leaves a PINNED reader alone — the bottom is their anchor', () => {
    // Two owners of one scroll position is how the last three of these
    // started; the re-pin observer already holds this case.
    expect(
      scrollTopAfterFoldChange({
        pinned: true,
        anchorRowTop: -230,
        anchorOffset: 200,
        scrollTop: 23071,
        scrollHeight: 26468,
        clientHeight: 684,
      }),
    ).toBe(null);
  });

  it('declines to guess when there is no row to measure', () => {
    // A hidden pane, or a chat with nothing anchorable. Leaving the scroll
    // alone is imprecise; inventing a target is wrong.
    expect(
      scrollTopAfterFoldChange({
        pinned: false,
        anchorRowTop: null,
        anchorOffset: 200,
        scrollTop: 23071,
        scrollHeight: 26468,
        clientHeight: 684,
      }),
    ).toBe(null);
  });

  it('clamps, like every other target in this file', () => {
    // The caller stamps the result as lastProgrammaticTop, and a value the
    // browser clamps would never equal the real scrollTop — so the very next
    // scroll event would read as the reader taking control.
    expect(
      scrollTopAfterFoldChange({
        pinned: false,
        anchorRowTop: 900,
        anchorOffset: 0,
        scrollTop: 100,
        scrollHeight: 1200,
        clientHeight: 600,
      }),
    ).toBe(600);
    expect(
      scrollTopAfterFoldChange({
        pinned: false,
        anchorRowTop: -900,
        anchorOffset: 0,
        scrollTop: 100,
        scrollHeight: 1200,
        clientHeight: 600,
      }),
    ).toBe(0);
  });
});

describe('scrollMotionIsTheReader', () => {
  // The regression that scoping `overflow-anchor` to the pinned state
  // introduced: the engine pays an unpinned reader for growth above them by
  // writing scrollTop during layout, and that write dispatches a scroll event
  // nobody can stamp. Measured in headless Chromium — reader's row unmoved,
  // scrollTop 4000 -> 4480, exactly one scroll event, flag flipped true.
  it('does NOT blame the reader for an anchoring adjustment', () => {
    expect(
      scrollMotionIsTheReader({ resized: true, scrollTop: 4480, lastProgrammaticTop: 4000 }),
    ).toBe(false);
  });

  it('still catches a reader who scrolled with no resize', () => {
    expect(
      scrollMotionIsTheReader({ resized: false, scrollTop: 4480, lastProgrammaticTop: 4000 }),
    ).toBe(true);
  });

  it('does not blame the reader for our OWN programmatic write', () => {
    expect(
      scrollMotionIsTheReader({ resized: false, scrollTop: 4000, lastProgrammaticTop: 4000 }),
    ).toBe(false);
    // Sub-pixel rounding is not a gesture either.
    expect(
      scrollMotionIsTheReader({ resized: false, scrollTop: 4000.6, lastProgrammaticTop: 4000 }),
    ).toBe(false);
  });
});

describe('retiring an anchor the seek could not reach', () => {
  // The seek budget is a local of the restore effect and that effect re-runs on
  // every visibility flip, so a stored anchor that is never going to be found
  // costs eight `load-older` round trips PER FLIP — and each re-run re-applies
  // the ratio against a document the previous ones grew. Handing over the row
  // the fallback actually settled on makes the next restore an ordinary one.
  const geometry = {
    scrollTop: 4000,
    scrollHeight: 20000,
    clientHeight: 800,
    lastRowBottom: 19000,
    sid: 'sid-1',
  };

  it('names the row the loop settled on, not the ghost it was hunting', () => {
    const m = retiredAnchorMemory({
      live: { anchorId: 'evt-live', anchorOffset: -120 },
      ...geometry,
    });
    expect(m.anchorId).toBe('evt-live');
    expect(m.anchorOffset).toBe(-120);
    expect(m.sid).toBe('sid-1');
    // A findable anchor is exactly what stops `opensAtNewest` sending the next
    // open to the bottom AND stops the loop seeking again.
    expect(opensAtNewest(m)).toBe(false);
  });

  it('records the ratio the reader is actually at, clamped', () => {
    expect(retiredAnchorMemory({ live: null, ...geometry }).ratio).toBeCloseTo(
      4000 / (20000 - 800),
      5,
    );
    // iOS rubber-band reports a scrollTop outside the range.
    expect(
      retiredAnchorMemory({ live: null, ...geometry, scrollTop: -40 }).ratio,
    ).toBe(0);
    expect(
      retiredAnchorMemory({ live: null, ...geometry, scrollTop: 99999 }).ratio,
    ).toBe(1);
  });

  it('MEASURES caught-up rather than assuming the reader is parked', () => {
    // The fallback left them mid-history: the newest row ends far below.
    expect(retiredAnchorMemory({ live: { anchorId: 'a', anchorOffset: 0 }, ...geometry }).caughtUp)
      .toBe(false);
    // …and left them at the end: saying so is what stops the NEXT open pinning
    // them to a message that is no longer the newest.
    expect(
      retiredAnchorMemory({
        live: { anchorId: 'a', anchorOffset: 0 },
        ...geometry,
        scrollTop: 19200,
        lastRowBottom: 790,
      }).caughtUp,
    ).toBe(true);
  });

  it('falls back to no anchor when nothing is anchorable', () => {
    const m = retiredAnchorMemory({ live: null, ...geometry });
    expect(m.anchorId).toBeNull();
    expect(m.anchorOffset).toBe(0);
  });
});
