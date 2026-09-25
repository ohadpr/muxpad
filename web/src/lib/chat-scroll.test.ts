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
  scrollEventIsTrustworthy,
  scrollMemorySidMatches,
  scrollMotionIsTheReader,
  scrollTopAfterFoldChange,
  scrollTopAfterOlderPrepend,
  scrollTopForAnchor,
  scrollTopForSearchHit,
  shouldPersistChatScroll,
  shouldRememberPosition,
  shouldRestorePosition,
} from './chat-scroll';

/**
 * A remembered position: a PARKED reader by default, because that is the case
 * worth defaulting to — it is the one with something to lose.
 *
 * `anchorId` is part of that default deliberately. It used to be null here, so
 * every fixture that meant "a reader who had scrolled back" was actually a row
 * naming no message at all — a shape that cannot arise from a real parked
 * reader, and which `opensAtNewest` now correctly reads as "open at the newest".
 * Pass `anchorId: null` explicitly to build a retirement.
 */
function memo(over: Partial<ChatScrollMem> = {}): ChatScrollMem {
  return { anchorId: 'evt#parked', anchorOffset: 0, caughtUp: false, sid: null, ...over };
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
    expect(opensAtNewest(memo({ caughtUp: false, sid: 's1' }))).toBe(false);
  });

  it('opens at the newest message when the reader had read to the end', () => {
    expect(opensAtNewest(memo({ caughtUp: true, sid: 's1' }))).toBe(true);
  });
});

describe('readerIsCaughtUp — has the reader reached the end?', () => {
  // Geometry from the real component: a 1100x800 pane. `distance` below is
  // always scrollHeight - scrollTop - clientHeight, i.e. how much of the
  // document is still below the fold.
  const at = (distance: number, docHeight = 20_000) =>
    readerIsCaughtUp({
      scrollTop: docHeight - 800 - distance,
      scrollHeight: docHeight,
      clientHeight: 800,
    });

  it('resting at the bottom is caught up', () => {
    expect(at(0)).toBe(true);
  });

  // The first report, in its smallest honest form. One wheel notch (Chromium:
  // ~120px) to re-read the last line is 3x the 40px live-follow threshold, so
  // persisting the PIN as the re-entry policy filed this reader under "parked in
  // history" and anchored them to that message forever. Nothing about it is
  // visible until the agent talks; then the anchor is faithfully restored thirty
  // messages above the newest one — measured, 5701px up.
  it('a one-notch nudge off the bottom is still CAUGHT UP', () => {
    expect(at(120)).toBe(true);
  });

  it('is NOT caught up once the reader has scrolled meaningfully away', () => {
    expect(at(400)).toBe(false);
  });

  it('is NOT caught up when parked deep in older history', () => {
    expect(at(4698)).toBe(false);
  });

  // "I come back to muxpad and it scrolls to the very bottom instead of my last
  // position." A Chat-mode reply with its action run folded above it, or an
  // Agent-mode tool result, runs to several screens. The rule used to ask whether
  // the newest message had STARTED on screen, so a reader on its first screen was
  // filed as caught up — and re-entry means "open at the newest message", so they
  // came back to the END of the thing they were halfway through.
  it('is NOT caught up on the first screen of a newest message taller than the viewport', () => {
    // A 2400px newest message, its top at the viewport top: 1600px of it is
    // still below the fold, plus the composer's ~128px reserve.
    expect(at(1728)).toBe(false);
  });

  it('…and IS caught up once the reader reaches that message’s end', () => {
    expect(at(10)).toBe(true);
  });

  // ── The neighbour the message-shaped rule got wrong ───────────────────────
  // Everything a live turn renders below the newest committed message — the
  // streaming preview, the optimistic user bubble, the question card, the queued
  // strip — carries no `data-eid`, so a rule that walks anchored rows cannot see
  // it. A reader who scrolled up to the end of the last committed message while
  // three screens of streaming output sat below them measured `lastRowBottom` of
  // about 790 against a 800px viewport, i.e. CAUGHT UP — and on re-entry was
  // taken to the newest message, which is content they had deliberately scrolled
  // away from and never read.
  //
  // Asking about the scroll range instead answers this for free: the preview is
  // in `scrollHeight` whether or not it is anchorable.
  it('is NOT caught up with unanchored live output below the newest message', () => {
    // The last committed row's bottom is 790 (on screen, so the old rule said
    // caught up) and three screens of streaming preview follow it.
    expect(at(2400)).toBe(false);
  });

  it('a document too short to scroll has no end to be short of', () => {
    expect(readerIsCaughtUp({ scrollTop: 0, scrollHeight: 400, clientHeight: 800 })).toBe(true);
  });

  // iOS rubber-band reports a scrollTop past the end, so the distance goes
  // NEGATIVE. That reader is at the bottom and then some.
  it('survives overscroll past the bottom', () => {
    expect(at(-40)).toBe(true);
  });
});

describe('the stored re-entry policy is not the live-follow pin', () => {
  // Two rounds of fixes went into the restore MECHANISM and the report survived
  // both, because the mechanism was never what was wrong: it restored exactly
  // what it was told. What was wrong is that the thing it was told came from
  // `pinnedToBottom`, a 40px live-auto-scroll threshold, being reused as the
  // answer to a different question — where should re-opening this tab land?
  const geo = (distance: number) => ({
    scrollTop: 20_000 - 800 - distance,
    scrollHeight: 20_000,
    clientHeight: 800,
  });

  it('a reader 120px off the bottom is unpinned for LIVE follow but caught up for RE-ENTRY', () => {
    const following = 120 < 40; // the component's live-follow test — false
    expect(following).toBe(false);
    const caughtUp = readerIsCaughtUp(geo(120));
    expect(caughtUp).toBe(true);
    // …and "caught up" is what a re-open consults, so the newest message wins
    // over the message they happened to be nudged onto.
    expect(opensAtNewest(memo({ caughtUp, anchorId: 'e196', sid: 's1' }))).toBe(true);
  });

  it('still keeps a genuinely scrolled-back reader exactly where they were', () => {
    const caughtUp = readerIsCaughtUp(geo(4698));
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
      rememberChatScroll('pane-x', memo({ caughtUp: false, sid: 's1' }));
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
    rememberChatScroll('p1', memo({ anchorId: 'evt#3', anchorOffset: -42 }));
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

  // ── THE RATIO IS GONE, AND OLD ROWS STILL READ ────────────────────────────
  // This replaces `still refuses an entry with no usable ratio at all`, which
  // asserted that a row whose `ratio` was not finite was treated as no memory.
  // That guard could not survive the field: after the removal EVERY row this
  // module writes would have failed it, so the store would have looked
  // permanently empty and every pane would have opened at the bottom — the exact
  // reset the store exists to prevent, shipped as the fix for it.
  //
  // The key is deliberately not re-versioned (see the header), so rows written by
  // a build that still stored a ratio are in the store right now. They must be
  // read for the field that means something and the dead one ignored.
  it('reads a v4 row written with a ratio, and ignores the ratio', () => {
    const legacy = { anchorId: 'evt#40', anchorOffset: -3, ratio: 0.0363, caughtUp: false };
    localStorage.setItem(STORE_KEY, JSON.stringify([['p3', { ...legacy, at: Date.now() }]]));
    vi.resetModules();
    return import('./chat-scroll').then(({ recallChatScroll: recall }) => {
      const got = recall('p3');
      expect(got?.anchorId).toBe('evt#40');
      expect(got?.anchorOffset).toBe(-3);
      expect(got?.caughtUp).toBe(false);
      // Nothing carries the ratio forward. 0.0363 of the whole conversation is
      // what landed a reader parked on turn 40 at turn 296 when it was applied to
      // a 128KB tail; it must not be reachable from a recalled entry at all.
      expect('ratio' in (got as object)).toBe(false);
    });
  });

  it('a row with no anchor at all is the ordinary "open at the newest" row', () => {
    rememberChatScroll('p4', memo({ anchorId: null, caughtUp: false }));
    const got = recallChatScroll('p4');
    // Not null — it is a real row — and `opensAtNewest` is what interprets it.
    expect(got).not.toBeNull();
    expect(opensAtNewest(got)).toBe(true);
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
    rememberChatScroll('pane-j', memo({ anchorId: null, caughtUp: true, sid: 's1' }));

    // They search, follow a message hit, and land three weeks up the log. The
    // jump's own scrollTop writes fire onScroll like any other motion — each
    // one would record "parked at an ancient message, not caught up".
    for (const scrollTop of [0.05, 0.06, 0.07]) {
      if (shouldRememberPosition({ searchJumpActive: true })) {
        rememberChatScroll('pane-j', memo({ anchorId: 'evt#ancient', caughtUp: false, sid: 's1' }));
      }
    }

    // Tomorrow they click the tab, with no search involved. They must land at
    // the newest message, exactly as they would have without the search.
    const next = recallChatScroll('pane-j');
    expect(opensAtNewest(next)).toBe(true);
    // Nothing parked was left behind by the jump's own writes. Asserted as
    // "not `evt#ancient`" rather than "stored as ratio 1 with a null anchor":
    // a caught-up reader no longer occupies an LRU slot at all (see
    // rememberChatScroll), so the caught-up STATE is now carried by the
    // absence of a row as legitimately as by a row saying so. Both answer
    // `opensAtNewest` the same way, which is the only thing re-entry reads.
    expect(next?.anchorId ?? null).toBeNull();
  });

  it('leaves a SCROLLED-BACK reader on the message they had parked on', () => {
    // The other half: a jump must not overwrite a real parked spot either.
    rememberChatScroll(
      'pane-k',
      memo({ anchorId: 'evt#parked', anchorOffset: -120, caughtUp: false, sid: 's1' }),
    );
    if (shouldRememberPosition({ searchJumpActive: true })) {
      rememberChatScroll('pane-k', memo({ anchorId: 'evt#hit', sid: 's1' }));
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
    rememberChatScroll('pane-l', memo({ caughtUp: true, sid: 's1' }));
    const readerTookOver = false; // …then a wheel event cleared the hold
    if (shouldRememberPosition({ searchJumpActive: readerTookOver })) {
      rememberChatScroll(
        'pane-l',
        memo({ anchorId: 'evt#reading-here', caughtUp: false, sid: 's1' }),
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
      rememberChatScroll('pane-m', memo({ anchorId: 'evt#hit', caughtUp: false }));
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
    rememberChatScroll('pane-v', memo({ anchorId: 'evt#147', caughtUp: false }));

    // 2. They search and land on a much later message. Every frame of the
    //    placement writes a scroll event; all of them are declined.
    const jumpHolds = true;
    if (shouldRememberPosition({ searchJumpActive: jumpHolds })) {
      rememberChatScroll('pane-v', memo({ anchorId: 'evt#198' }));
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
      memo({ anchorId: 'evt#7', anchorOffset: -120, caughtUp: false, sid: 's1' }),
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
        ['pane-legacy', { anchorId: 'evt#3', anchorOffset: -10, caughtUp: false, sid: 's1' }],
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
  // An anchoring adjustment: the engine pays for growth above the reader by
  // moving scrollTop down by exactly that growth. Measured in headless
  // Chromium — reader's row unmoved, 1400 -> 1850, one scroll event.
  it('does NOT blame the reader for an anchoring adjustment', () => {
    expect(
      scrollMotionIsTheReader({
        scrollTop: 1850,
        lastScrollTop: 1400,
        heightDelta: 450,
        lastProgrammaticTop: 1400,
      }),
    ).toBe(false);
  });

  it('does not blame them when only SOME of the growth was above them', () => {
    // 450px arrived, 200 of it above the reader: the engine pays 200.
    expect(
      scrollMotionIsTheReader({
        scrollTop: 1600,
        lastScrollTop: 1400,
        heightDelta: 450,
        lastProgrammaticTop: 1400,
      }),
    ).toBe(false);
  });

  // The regression the validation fleet measured: the rule used to excuse EVERY
  // motion in a frame where the content changed, so a reader paging with the
  // keyboard or dragging a selection during a live turn was invisible for as
  // long as output kept arriving. 7128px of real motion, 0 reader verdicts
  // across 158 events.
  it('DOES blame the reader for motion layout cannot account for', () => {
    // 450px of growth cannot explain an 800px jump.
    expect(
      scrollMotionIsTheReader({
        scrollTop: 2200,
        lastScrollTop: 1400,
        heightDelta: 450,
        lastProgrammaticTop: 1400,
      }),
    ).toBe(true);
  });

  it('DOES blame the reader for scrolling UP while content grows', () => {
    // Growth pushes scrollTop down; reading backwards is unmistakably theirs.
    expect(
      scrollMotionIsTheReader({
        scrollTop: 1100,
        lastScrollTop: 1400,
        heightDelta: 450,
        lastProgrammaticTop: 1400,
      }),
    ).toBe(true);
  });

  it('still catches a reader who scrolled with no growth at all', () => {
    expect(
      scrollMotionIsTheReader({
        scrollTop: 4480,
        lastScrollTop: 4000,
        heightDelta: 0,
        lastProgrammaticTop: 4000,
      }),
    ).toBe(true);
  });

  it('does not blame the reader for our OWN programmatic write', () => {
    expect(
      scrollMotionIsTheReader({
        scrollTop: 4000,
        lastScrollTop: 4000,
        heightDelta: 0,
        lastProgrammaticTop: 4000,
      }),
    ).toBe(false);
  });

  it('treats content shrinking as layout, not a gesture', () => {
    // A fold closing above the reader: scrollTop is clamped down by the engine.
    expect(
      scrollMotionIsTheReader({
        scrollTop: 900,
        lastScrollTop: 900,
        heightDelta: -450,
        lastProgrammaticTop: 900,
      }),
    ).toBe(false);
  });
});

/*
 * The `retiring an anchor the seek could not reach` block lived here — four
 * tests over `retiredAnchorMemory`, which wrote back whatever row the ratio
 * fallback had settled on when a seek gave up.
 *
 * Deleted with the function, and with the fallback that made it necessary.
 * Nothing guesses a position any more, so there is no guessed row to correct:
 * a seek that runs out of budget leaves the record untouched and the reader
 * where the document opened. What stops the budget being re-spent on every
 * visibility flip is now a counter that outlives the flip
 * (`ScrollState.pages`), tested in chat-scroll-intent.test.ts.
 *
 * Worth recording why the tests passed while the behaviour was wrong: they
 * asserted that retirement named "the row the loop settled on, not the ghost it
 * was hunting", which the function did. The defect was upstream of anything they
 * could see — the row it named had been chosen by arithmetic against a fraction
 * of the conversation — and the guard added for THAT (never retire while history
 * is unloaded) silently disabled retirement in the commonest case, so every tab
 * switch re-spent eight `load-older` round trips. Two correct rules, composed
 * into the live bug, with green tests over both.
 */

describe('two windows, merged by WRITE TIME', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("preserves the other window's UPDATE to a pane this one loaded at boot", async () => {
    // The hazard `flush` carried for as long as it defined "foreign" as
    // `!mem.has(id)`: `mem` is filled AT IMPORT with the entire store, so every
    // key this window merely happened to load counted as its own forever — even
    // for a chat it never opened. Window B's newer position was then silently
    // undone the next time A flushed anything at all.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        ['shared', stored({ anchorId: 'parked-at-boot', at: Date.now() - 60_000 })],
        ['other', stored({ anchorId: 'other-boot', at: Date.now() - 60_000 })],
      ]),
    );
    vi.resetModules();
    const { rememberChatScroll: remember } = await import('./chat-scroll');

    // Window B parks `shared` somewhere else and flushes. A never opened it.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([
        ['shared', stored({ anchorId: 'parked-in-B', at: Date.now() })],
        ['other', stored({ anchorId: 'other-boot', at: Date.now() - 60_000 })],
      ]),
    );

    // A scrolls a DIFFERENT pane, which is all it takes to trigger a flush.
    remember('other', memo({ anchorId: 'other-moved' }));
    await flushed();

    const back = new Map(
      JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as [string, { anchorId: string }][],
    );
    expect(back.get('shared')?.anchorId).toBe('parked-in-B');
    expect(back.get('other')?.anchorId).toBe('other-moved');
  });

  it('adopts the other window on a `storage` event, so recall is not answering from boot', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['p', stored({ anchorId: 'boot', at: Date.now() - 60_000 })]]),
    );
    vi.resetModules();
    const { recallChatScroll: recall } = await import('./chat-scroll');
    expect(recall('p')?.anchorId).toBe('boot');

    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['p', stored({ anchorId: 'moved-in-B', at: Date.now() })]]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
    expect(recall('p')?.anchorId).toBe('moved-in-B');
  });

  it('does NOT let an older foreign row overwrite a newer local one', async () => {
    vi.resetModules();
    const { rememberChatScroll: remember, recallChatScroll: recall } = await import(
      './chat-scroll'
    );
    remember('p', memo({ anchorId: 'ours-now' }));
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['p', stored({ anchorId: 'theirs-stale', at: Date.now() - 60_000 })]]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
    expect(recall('p')?.anchorId).toBe('ours-now');
  });
});

describe('a close inside the debounce window', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('loses the parked position without a pagehide flush', async () => {
    // The shape of the bug, stated as the thing the fix has to beat: the write
    // is in memory immediately and in localStorage 250ms later, and every new
    // remember RESTARTS that timer — so a reader who scrolls to a message and
    // quits without pausing a quarter second never flushes any of it.
    vi.resetModules();
    const { rememberChatScroll: remember } = await import('./chat-scroll');
    remember('pane-park', memo({ anchorId: 'evt#69' }));
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('flushes on `pagehide` — the event a killed PWA does fire', async () => {
    vi.resetModules();
    const { rememberChatScroll: remember, opensAtNewest: newest } = await import('./chat-scroll');
    remember('pane-park', memo({ anchorId: 'evt#69' }));
    window.dispatchEvent(new Event('pagehide'));

    // The cold open: a relaunched PWA is a NEW browsing context.
    sessionStorage.clear();
    vi.resetModules();
    const { recallChatScroll: recall } = await import('./chat-scroll');
    expect(recall('pane-park')?.anchorId).toBe('evt#69');
    expect(newest(recall('pane-park'))).toBe(false);
  });

  it('flushes when the document goes hidden — iOS freezes timers there', async () => {
    vi.resetModules();
    const { rememberChatScroll: remember } = await import('./chat-scroll');
    remember('pane-bg', memo({ anchorId: 'evt#12' }));
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      spy.mockRestore();
    }
    expect(localStorage.getItem(STORE_KEY)).toContain('evt#12');
  });
});

describe('the LRU cap holds PARKED spots, not the default', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('spends no PARKED slot on a caught-up reader', async () => {
    vi.resetModules();
    const {
      rememberChatScroll: remember,
      opensAtNewest: newest,
      recallChatScroll: recall,
    } = await import('./chat-scroll');
    // MAX_ENTRIES parked panes, then a storm of caught-up traffic on top. If
    // the two shared a budget the caught-up rows would evict the parked ones —
    // they are the newer writes — and the oldest parked pane is exactly the one
    // the reader has been away from longest.
    for (let i = 0; i < 200; i++) remember(`parked-${i}`, memo({ anchorId: `evt#${i}` }));
    for (let i = 0; i < 200; i++) {
      remember(`caught-${i}`, memo({ anchorId: null, caughtUp: true }));
    }
    await flushed();
    expect(recall('parked-0')?.anchorId).toBe('evt#0');
    expect(recall('parked-199')?.anchorId).toBe('evt#199');
    // A caught-up row IS written — that is what retires the parked row another
    // window is holding, see below — but it is budgeted separately, and it
    // answers re-entry the same way no memory at all does.
    expect(newest(recall('caught-199'))).toBe(true);
    const rows = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as [string, ChatScrollMem][];
    expect(rows.filter(([, m]) => !m.caughtUp)).toHaveLength(200);
    expect(rows.filter(([, m]) => m.caughtUp).length).toBeLessThanOrEqual(50);
  });

  it('does not let a store full of INHERITED caught-up rows evict a parked one', async () => {
    // The upgrade path. A build that stored caught-up readers as ordinary
    // entries left them in the same v4 key — deliberately not re-versioned —
    // and nothing on the read side filtered them, so they kept the slots they
    // had taken. The wanted row here is the OLDEST, i.e. the first evicted.
    const rows: [string, unknown][] = [
      ['wanted', stored({ anchorId: 'evt#69', caughtUp: false, at: Date.now() - 60_000 })],
    ];
    for (let i = 0; i < 200; i++) {
      rows.push([`legacy-caught-${i}`, stored({ caughtUp: true, at: Date.now() - i })]);
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(rows));
    vi.resetModules();
    const { rememberChatScroll: remember, recallChatScroll: recall } = await import(
      './chat-scroll'
    );
    remember('fresh', memo({ anchorId: 'evt#new' }));
    await flushed();
    expect(recall('wanted')?.anchorId).toBe('evt#69');
    expect(localStorage.getItem(STORE_KEY)).toContain('evt#69');
  });

  it('keeps every position a cockpit of 37 live panes plus a fortnight of closed ones parked', async () => {
    // The measured shape of the loss at a cap of 50: this machine runs ~37 chat
    // panes at once, and a chat closed today is still inside the 14-day cutoff,
    // so ordinary churn pushes the count past the cap within a fortnight. The
    // row evicted is the least-recently-WRITTEN — the pane left alone longest,
    // which is the one most likely to be worth coming back to.
    vi.resetModules();
    const { rememberChatScroll: remember, recallChatScroll: recall } = await import(
      './chat-scroll'
    );
    for (let i = 0; i < 37; i++) remember(`live-${i}`, memo({ anchorId: `live#${i}` }));
    for (let i = 0; i < 40; i++) remember(`closed-${i}`, memo({ anchorId: `closed#${i}` }));
    await flushed();
    expect(recall('live-0')?.anchorId).toBe('live#0');
    expect(recall('closed-0')?.anchorId).toBe('closed#0');
  });

  it('keeps a parked pane alive through a storm of caught-up traffic', async () => {
    // The measured failure: 37 parked live panes plus the caught-up chats that
    // follow-bottom rewrites constantly. Those rewrites kept the caught-up rows
    // at the fresh end of the LRU and aged the PARKED ones to the front, so the
    // cap evicted exactly the positions it exists to keep.
    vi.resetModules();
    const { rememberChatScroll: remember, recallChatScroll: recall } = await import(
      './chat-scroll'
    );
    remember('parked-00', memo({ anchorId: 'evt#69', caughtUp: false }));
    for (let i = 0; i < 120; i++) {
      remember(`follow-${i}`, memo({ anchorId: null, caughtUp: true }));
    }
    expect(recall('parked-00')?.anchorId).toBe('evt#69');
  });

  it('a caught-up write RETIRES a stored parked row, here and in storage', async () => {
    // Dropping it from the map is not enough on its own — `flush` merges what
    // is already in localStorage, so a deleted row would be read straight back.
    vi.resetModules();
    const {
      rememberChatScroll: remember,
      recallChatScroll: recall,
      opensAtNewest: newest,
    } = await import('./chat-scroll');
    remember('p', memo({ anchorId: 'evt#7', caughtUp: false }));
    await flushed();
    expect(localStorage.getItem(STORE_KEY)).toContain('evt#7');
    remember('p', memo({ anchorId: null, caughtUp: true }));
    await flushed();
    // The reader opens at the newest message, as if nothing were remembered…
    expect(newest(recall('p'))).toBe(true);
    // …and the message id they were parked on is GONE, not merely shadowed by a
    // flag: anything reading one field and not the other must not be able to
    // put them back there. (A boundary, not a regression test — the design that
    // removed the row outright satisfied it too.)
    expect(recall('p')?.anchorId ?? null).toBeNull();
    expect(localStorage.getItem(STORE_KEY)).not.toContain('evt#7');
  });

  it("…but yields to another window's NEWER parked position for that pane", async () => {
    vi.resetModules();
    const { rememberChatScroll: remember, recallChatScroll: recall } = await import(
      './chat-scroll'
    );
    remember('p', memo({ anchorId: null, caughtUp: true }));
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['p', stored({ anchorId: 'parked-in-B', at: Date.now() + 1000 })]]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
    expect(recall('p')?.anchorId).toBe('parked-in-B');
    remember('other', memo());
    await flushed();
    expect(localStorage.getItem(STORE_KEY)).toContain('parked-in-B');
  });
});

describe('a retirement in ANOTHER window', () => {
  // The half of "two windows" that a merge by write time cannot express on its
  // own. An UPDATE in window B is a row, and a row can out-rank window A's
  // older one. A RETIREMENT in B used to be an ABSENCE — and absence carries no
  // timestamp, so A could not tell "B deleted this a second ago" from "this was
  // never here". A's next flush read its own stale row back over the deletion
  // and the reader was returned to a message they had finished with.
  //
  // Both windows are real module instances over one localStorage: `vi.resetModules()`
  // plus a fresh import is a second window, in the only sense this file has one.
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  /** A parks `p` in history; B boots from the same store and reads to the end. */
  async function parkedInAretiredInB() {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['p', stored({ anchorId: 'old-park', at: Date.now() - 60_000 })]]),
    );
    vi.resetModules();
    const A = await import('./chat-scroll');
    expect(A.recallChatScroll('p')?.anchorId).toBe('old-park');

    vi.resetModules();
    const B = await import('./chat-scroll');
    B.rememberChatScroll('p', memo({ anchorId: null, caughtUp: true }));
    B.flushChatScrollNow();
    return A;
  }

  /** What the next COLD open of the app would do with pane `p`. */
  async function coldOpenOpensAtNewest() {
    vi.resetModules();
    const C = await import('./chat-scroll');
    return C.opensAtNewest(C.recallChatScroll('p'));
  }

  it('reaches this window, instead of leaving it answering from boot', async () => {
    const A = await parkedInAretiredInB();
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
    expect(A.opensAtNewest(A.recallChatScroll('p'))).toBe(true);
  });

  it('is not undone by this window flushing something else entirely', async () => {
    const A = await parkedInAretiredInB();
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
    // A scrolls a DIFFERENT pane — which is all it takes to trigger a flush of
    // A's whole map.
    A.rememberChatScroll('unrelated', memo({ anchorId: 'somewhere-else' }));
    A.flushChatScrollNow();
    expect(await coldOpenOpensAtNewest()).toBe(true);
  });

  it('survives an IDLE window closing, which writes nothing of its own', async () => {
    // The `pagehide` flush is unconditional — it has to be, since a window with
    // a pending debounced write looks no different from one without. So closing
    // a window that has done nothing at all still serialises its map, and that
    // map is where the stale row lives.
    const A = await parkedInAretiredInB();
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
    A.flushChatScrollNow(); // what the `pagehide` listener calls
    expect(await coldOpenOpensAtNewest()).toBe(true);
  });

  it('…even when the `storage` event never arrived at all', async () => {
    // A tab discarded and restored, a listener that never fired, a window that
    // was frozen through the write: the merge must be right on its own, not
    // only when every event is delivered. A row can lose a timestamp
    // comparison; an absence cannot enter one.
    const A = await parkedInAretiredInB();
    A.flushChatScrollNow();
    expect(await coldOpenOpensAtNewest()).toBe(true);
  });

  it("still yields to another window's NEWER parked position for that pane", async () => {
    // The counterpart, and the reason the retirement is timestamped rather than
    // absolute: a reader who reads to the end here and then parks over there
    // gets their parked spot back, not this window's retirement.
    const A = await parkedInAretiredInB();
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([['p', stored({ anchorId: 'parked-in-C', at: Date.now() + 1000 })]]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }));
    expect(A.recallChatScroll('p')?.anchorId).toBe('parked-in-C');
    A.flushChatScrollNow();
    expect(await coldOpenOpensAtNewest()).toBe(false);
  });
});

describe('scrollTopForAnchor lands where a scroll-anchoring engine lands', () => {
  // ── WHAT THIS PROVES, AND WHAT IT DOES NOT ─────────────────────────────────
  // Read this before trusting the block. It used to be titled for WebKit and
  // iOS 26, which is more than it can show: these are calls to one exported
  // function with numbers handed to it, in jsdom, which measures nothing and
  // has no scroll anchoring of its own to have or lack. Specifically:
  //
  //  · It CANNOT fail if ChatPane stops writing the compensation. That call
  //    site is in another file, and removing `el.scrollTop = target` from it
  //    leaves this whole suite green — recorded in val-val-test-honesty.md.
  //    The gap is real and is not closed here.
  //  · It says NOTHING about iOS 26 / WKWebView. No WebKit was run. The only
  //    browser reachable from this repo's agent tooling is headless Chromium.
  //
  // What it does prove is worth having, because the numbers are not invented.
  // They are a measurement, taken through the Playwright MCP against headless
  // Chromium on 2026-09-23 — full probe and raw output in
  // /tmp/muxpad-hunt/f2-storage/anchoring-probe.md — of one 600px scroller
  // parked at scrollTop 4000, then grown by 450px ABOVE the reader. The probe
  // row is the one `firstVisibleRow` would pick (the first whose bottom is
  // below the viewport top), so its geometry is the geometry this store
  // actually stores: row19, top −181, height 201.
  //
  //   overflow-anchor: auto   scrollTop 4000 → 4450   row stays at −181
  //   overflow-anchor: none   scrollTop 4000 → 4000   row drifts to +269
  //
  // So 4450 is an ORACLE, not an assumption: it is where a real engine put a
  // real reader for that exact growth. The rule below is that the JS
  // compensation must reach the same number from the un-anchored geometry, and
  // must ask for nothing at all from the anchored one. A `scrollTop += Δheight`
  // would move 450 in BOTH rows; that is the double-pay this replaced.
  const MEASURED = {
    growth: 450,
    clientHeight: 600,
    scrollHeightAfter: 20550,
    scrollTopBefore: 4000,
    rowTopBefore: -181,
    rowHeight: 201,
    // overflow-anchor: none — the engine paid nothing.
    unanchored: { scrollTop: 4000, rowTop: 269 },
    // overflow-anchor: auto — the engine paid, and this is the answer to match.
    anchored: { scrollTop: 4450, rowTop: -181 },
  };
  // `anchorOffset` is the row's top relative to the viewport top as the reader
  // left it — `getBoundingClientRect().top - viewportTop`, the same quantity
  // and the same sign the probe reports.
  const anchorOffset = MEASURED.rowTopBefore;
  const rowHeight = MEASURED.rowHeight;

  it('reaches the anchoring engine’s own answer from the un-anchored geometry', () => {
    expect(
      scrollTopForAnchor({
        scrollTop: MEASURED.unanchored.scrollTop,
        rowTop: MEASURED.unanchored.rowTop,
        anchorOffset,
        rowHeight,
        scrollHeight: MEASURED.scrollHeightAfter,
        clientHeight: MEASURED.clientHeight,
      }),
    ).toBe(MEASURED.anchored.scrollTop);
  });

  it('asks for nothing where the engine already paid, so the two cannot stack', () => {
    // The measured anchored row, fed to the same function: the target equals
    // the scrollTop the engine arrived at, and the caller's `<= 1` guard then
    // declines to write it. Double-paying here is what would leap a reader
    // 450px on a browser that was already handling it correctly.
    const target = scrollTopForAnchor({
      scrollTop: MEASURED.anchored.scrollTop,
      rowTop: MEASURED.anchored.rowTop,
      anchorOffset,
      rowHeight,
      scrollHeight: MEASURED.scrollHeightAfter,
      clientHeight: MEASURED.clientHeight,
    });
    expect(target).toBe(MEASURED.anchored.scrollTop);
    expect(Math.abs(MEASURED.anchored.scrollTop - target) <= 1).toBe(true);
  });

  it('ignores growth BELOW the reader, which a height delta would not', () => {
    // The agent talking while someone reads history: scrollHeight grows, the
    // reader's row does not move, and neither do they. A `scrollTop += Δheight`
    // would have yanked them down by the whole turn.
    expect(
      scrollTopForAnchor({
        scrollTop: MEASURED.scrollTopBefore,
        rowTop: MEASURED.rowTopBefore,
        anchorOffset,
        rowHeight,
        scrollHeight: MEASURED.scrollHeightAfter,
        clientHeight: MEASURED.clientHeight,
      }),
    ).toBe(MEASURED.scrollTopBefore);
  });
});

describe('shouldPersistChatScroll — a hidden document has no reading position', () => {
  // iOS resets overflow scroll on resume (the whole reason `showEpoch` exists),
  // and the native scroll event from that reset can land before the restore
  // effect has armed its suppression window. Persisting it writes ratio ~0 over
  // the reader's parked message, and the restore then faithfully reproduces it.
  it('refuses while the document is hidden', () => {
    expect(shouldPersistChatScroll({ active: true, clientHeight: 800, visible: false })).toBe(
      false,
    );
  });

  it('accepts when visible, and when the caller does not say (tests / older callers)', () => {
    expect(shouldPersistChatScroll({ active: true, clientHeight: 800, visible: true })).toBe(true);
    expect(shouldPersistChatScroll({ active: true, clientHeight: 800 })).toBe(true);
  });
});

describe('an older prepend captured mid rubber-band', () => {
  // iOS overscroll reports a scrollTop outside [0, max], and a reader paging
  // older history IS at the top of the document, mid-bounce, by construction.
  // The persist path already clamps its ratio; the prepend capture did not.
  it('lands on the same messages, not 40px into the new page', () => {
    const unclamped = scrollTopAfterOlderPrepend({
      pinned: false,
      anchorHeight: 8000,
      anchorTop: -40,
      newScrollHeight: 10000,
      clientHeight: 800,
    });
    const clamped = scrollTopAfterOlderPrepend({
      pinned: false,
      anchorHeight: 8000,
      anchorTop: Math.min(Math.max(0, -40), maxScrollTop(8000, 800)),
      newScrollHeight: 10000,
      clientHeight: 800,
    });
    expect(unclamped).toBe(1960);
    expect(clamped).toBe(2000);
  });
});
