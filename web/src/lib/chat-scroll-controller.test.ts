/**
 * The scroll mechanism driven through a deterministic layout (chat-scroll-sim).
 *
 * This is the tier that did not exist before the rewrite. Everything here is an
 * ORDERING property — a prepend and an append in one commit, a burst landing
 * between a write and its scroll event, a fold collapsing above the reader, an
 * engine adjustment that stamps nothing — and none of it can be expressed
 * against jsdom, which has no layout. Every compensation property is asserted
 * under BOTH engine settings, because both are shipping configurations and two
 * careful measurements of Chromium disagreed about which one it is.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatScrollMem } from './chat-scroll';
import { ChatScrollController } from './chat-scroll-controller';
import { SEEK_PAGE_BUDGET } from './chat-scroll-intent';
import { SimScroller, simRows } from './chat-scroll-sim';

const PARKED = (id: string, offset = 0): ChatScrollMem => ({
  anchorId: id,
  anchorOffset: offset,
  caughtUp: false,
  sid: 's1',
});
const RETIRED: ChatScrollMem = { anchorId: null, anchorOffset: 0, caughtUp: true, sid: 's1' };

/** Deliver every pending scroll event to the controller. */
function drainScroll(sim: SimScroller, c: ChatScrollController): number {
  let readerVerdicts = 0;
  while (sim.takeScrollEvent()) {
    if (c.onScroll()) readerVerdicts++;
  }
  return readerVerdicts;
}

/** Both shipping engine configurations. */
const ENGINES = [
  { name: 'engine pays (Chromium, Safari 27)', paysAnchoring: true },
  { name: 'engine pays nothing (iOS 26 and earlier)', paysAnchoring: false },
] as const;

it('keeps the resume gate shut on a measurable surface until shown', () => {
  const sim = new SimScroller(simRows(40));
  const c = new ChatScrollController(sim);
  c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
  drainScroll(sim, c);
  c.dispatch({ t: 'hidden' });
  expect(c.hasPlaced()).toBe(false);
  // A commit/observer can run in the gap before the queued show transition.
  c.place();
  expect(c.hasPlaced()).toBe(false);
  sim.iosResumeZeroesScroll();
  expect(drainScroll(sim, c)).toBe(0);
  expect(c.record('s1')).toEqual(PARKED('m15', -60));
  c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
  expect(sim.scrollTop).toBe(3060);
});

describe('FOLLOWING', () => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
  });

  it('keeps an upward gesture when a commit precedes its scroll event', () => {
    drainScroll(sim, c);
    sim.readerScrollsBy(-25);
    const top = sim.scrollTop;
    sim.append(simRows(1, 200, 'new'));
    c.place();
    expect(sim.scrollTop).toBe(top);
    expect(c.phase(true)).toBe('ANCHORED');
    expect(drainScroll(sim, c)).toBe(1);
  });

  it('clearing an absent or already-dismissed search preserves a nudge', () => {
    drainScroll(sim, c);
    sim.readerScrollsBy(-25);
    drainScroll(sim, c);
    const top = sim.scrollTop;
    c.dispatch({ t: 'search-cleared', here: c.anchorHere(), atEnd: true });
    expect(sim.scrollTop).toBe(top);
    expect(c.phase(true)).toBe('ANCHORED');
  });

  it('opens at the end', () => {
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('stays at the end as live output arrives', () => {
    for (let i = 0; i < 5; i++) {
      sim.append(simRows(1, 300, `live${i}-`));
      c.place();
      drainScroll(sim, c);
    }
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('stays at the end when the composer regrows under it', () => {
    sim.setFurniture(240);
    c.place();
    drainScroll(sim, c);
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });

  it('stays at the end when the viewport shrinks', () => {
    sim.clientHeight = 500;
    c.place();
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });

  // ── THE BURST ─────────────────────────────────────────────────────────────
  // The measured bug, in its exact shape. A re-pin computes the bottom inside
  // its callback and assigns it; the scroll event that assignment produces is
  // dispatched a frame later. When a burst of lazy thumbnails all finish in one
  // layout pass, MORE content lands in between — measured: a write of 24910
  // against scrollHeight 25774, two more screenshots decoded in the same pass
  // (27934), event dispatched 2160px from a bottom that had moved. Un-pinning on
  // that was permanent: the chat silently stopped following for the rest of the
  // visit and the distance grew with every later turn (5280 -> 6284px), 3/3 on
  // two trees.
  it('a thumbnail burst between the write and its scroll event does not stop it following', () => {
    sim.append(simRows(1, 300, 'img-'));
    c.place(); // writes the bottom as it is NOW
    // …and two more thumbnails decode before the scroll event is delivered.
    sim.resizeRow('img-0', 2400);
    const readerVerdicts = drainScroll(sim, c);
    expect(readerVerdicts).toBe(0);
    c.place();
    expect(c.phase(true)).toBe('FOLLOWING');
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });

  // The union guard this replaces measured 0/3 here, because its first condition
  // was a flag set by the reader's first wheel event and cleared only on hide.
  it('…still not, for a reader who scrolled up and came back earlier in the visit', () => {
    sim.readerScrollsBy(-1500);
    expect(drainScroll(sim, c)).toBe(1);
    sim.readerScrollsToEnd();
    drainScroll(sim, c);
    expect(c.phase(true)).toBe('FOLLOWING');

    sim.append(simRows(1, 300, 'img-'));
    c.place();
    sim.resizeRow('img-0', 2400);
    expect(drainScroll(sim, c)).toBe(0);
    c.place();
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });

  // …and 1/3 here, because the button set that flag explicitly: the gesture that
  // means "I want to follow the tail again" disabled the thing that keeps you
  // there.
  it('…still not, immediately after tapping jump-to-latest', () => {
    sim.readerScrollsBy(-4000);
    drainScroll(sim, c);
    c.dispatch({ t: 'jump-to-latest' });
    sim.append(simRows(1, 300, 'img-'));
    c.place();
    sim.resizeRow('img-0', 2400);
    expect(drainScroll(sim, c)).toBe(0);
    c.place();
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });

  it('is lost to a real gesture, and regained by reaching the end', () => {
    sim.readerScrollsBy(-3000);
    expect(drainScroll(sim, c)).toBe(1);
    expect(c.phase(true)).toBe('ANCHORED');
    sim.readerScrollsToEnd();
    drainScroll(sim, c);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('has no fuse — it still follows after a thousand height changes', () => {
    for (let i = 0; i < 1000; i++) {
      sim.append(simRows(1, 40, `t${i}-`));
      c.place();
      drainScroll(sim, c);
    }
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });
});

describe.each(ENGINES)('ANCHORED — $name', ({ paysAnchoring }) => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(40), { paysAnchoring, furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsTo(3000);
    drainScroll(sim, c);
  });

  it('holds the reader’s row through an older-history prepend', () => {
    const before = sim.rowOffset('m15');
    sim.prepend(simRows(5, 400, 'old'));
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m15')).toBe(before);
  });

  /**
   * THE READER SCROLLING WHILE HISTORY LANDS, IN THE SAME FRAME.
   *
   * Reported as "scrolling up from the bottom is super buggy and janky and
   * stuck". Measured in Chromium against a real chat: scrolling up at frame
   * rate, roughly one frame in twelve moved the view NOT AT ALL, and every one
   * of those frames carried a single write from `place()` of exactly the size
   * of the step that had just been made. The gesture was being handed back.
   *
   * The cause is the reconcile guard: it believed a `scrollTop` change was the
   * reader only when the anchor row had not moved in DOCUMENT space. A prepend
   * moves it by definition — that is what a prepend is — so on exactly the
   * frames where history arrives, a simultaneous gesture was attributed to
   * layout and overwritten. Which is the worst possible frame to lose one on:
   * paging history in is the thing scrolling up DOES.
   */
  it('keeps the reader’s gesture when a prepend lands in the same frame', () => {
    const before = sim.rowOffset('m15');
    // Both in one frame, no scroll event delivered in between — the ordering
    // the simulator exists for.
    sim.prepend(simRows(5, 400, 'old'));
    sim.readerScrollsBy(-120);
    c.place();
    drainScroll(sim, c);
    // The reader asked to move 120px up the document and must have got it:
    // their row sits 120px lower in the viewport than it did.
    expect(sim.rowOffset('m15')).toBe(before + 120);
  });

  it('believes a SCROLLBAR DRAG, which produces no input events', () => {
    // A drag fires no wheel, no touch and no key — and nor does a middle-click
    // autoscroll or a click in the scrollbar track. The first cut of the input
    // signal dropped all of them; a probe that moved `scrollTop` directly
    // recorded no position at all. With the document standing still there is
    // nothing for an engine to have compensated, so the arithmetic is sound.
    const before = sim.rowOffset('m15');
    sim.scrollTopSilently(sim.scrollTop - 120);
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m15')).toBe(before + 120);
  });

  it('still holds them put when ONLY the prepend happens', () => {
    // The other side of the same branch: no gesture, so nothing to reconcile,
    // and the row must not move at all.
    const before = sim.rowOffset('m15');
    sim.prepend(simRows(5, 400, 'old'));
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m15')).toBe(before);
  });

  it('holds it through an image decoding above them', () => {
    const before = sim.rowOffset('m15');
    sim.resizeRow('m2', 1200);
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m15')).toBe(before);
  });

  it('holds it through a fold collapsing above them', () => {
    const before = sim.rowOffset('m15');
    sim.resizeRow('m3', 26); // a 200px run snapping shut
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m15')).toBe(before);
  });

  // ── The case total-height arithmetic gets wrong ───────────────────────────
  // A live append and an older prepend landing in ONE commit. The compensation
  // this replaces captured `scrollHeight` before and after and applied the
  // difference, so it counted the APPEND as growth above the reader: measured,
  // it wrote 400 where 300 was right. A row-based target cannot make that
  // mistake, because it never looks at the document's height.
  it('holds it when a prepend and a live append land in one commit', () => {
    const before = sim.rowOffset('m15');
    sim.prepend(simRows(2, 200, 'old'));
    sim.append(simRows(1, 100, 'live'));
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m15')).toBe(before);
  });

  it('is not moved at all by growth BELOW them', () => {
    const before = sim.rowOffset('m15');
    const top = sim.scrollTop;
    sim.append(simRows(10, 400, 'live'));
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m15')).toBe(before);
    expect(sim.scrollTop).toBe(top);
  });

  it('has no fuse — it still holds after a hundred changes', () => {
    const before = sim.rowOffset('m15');
    for (let i = 0; i < 100; i++) {
      sim.append(simRows(1, 50, `t${i}-`));
      c.place();
      drainScroll(sim, c);
    }
    expect(sim.rowOffset('m15')).toBe(before);
  });
});

// ── PAY EXACTLY ONCE ────────────────────────────────────────────────────────
// The property that makes ONE owner safe next to an engine that is also an
// owner. The defence is the arithmetic, not a feature test: `CSS.supports(
// 'overflow-anchor', 'auto')` answers true on an iOS 26 WKWebView that will not
// pay and true on Playwright's WebKit that will, so it cannot tell these two
// configurations apart — and a height-delta form would double-pay in the first
// and yank the reader for growth below them in both.
describe('pays exactly once', () => {
  function parkedAt3000(paysAnchoring: boolean) {
    const sim = new SimScroller(simRows(40), { paysAnchoring, furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsTo(3000);
    drainScroll(sim, c);
    sim.writes.length = 0;
    return { sim, c };
  }

  it('writes NOTHING where the engine already paid', () => {
    const { sim, c } = parkedAt3000(true);
    const before = sim.rowOffset('m15');
    sim.prepend(simRows(3, 400, 'old'));
    c.place();
    drainScroll(sim, c);
    expect(sim.writes).toEqual([]);
    expect(sim.rowOffset('m15')).toBe(before);
  });

  it('pays in FULL where the engine paid nothing', () => {
    const { sim, c } = parkedAt3000(false);
    const before = sim.rowOffset('m15');
    sim.prepend(simRows(3, 400, 'old'));
    c.place();
    drainScroll(sim, c);
    expect(sim.writes).toEqual([3000 + 1200]);
    expect(sim.rowOffset('m15')).toBe(before);
  });

  it('lands in the same place either way', () => {
    const a = parkedAt3000(true);
    const b = parkedAt3000(false);
    for (const { sim, c } of [a, b]) {
      sim.prepend(simRows(3, 400, 'old'));
      c.place();
      drainScroll(sim, c);
    }
    expect(a.sim.scrollTop).toBe(b.sim.scrollTop);
    expect(a.sim.rowOffset('m15')).toBe(b.sim.rowOffset('m15'));
  });

  it('is idempotent — placing twice writes once', () => {
    const { sim, c } = parkedAt3000(false);
    sim.prepend(simRows(3, 400, 'old'));
    c.place();
    c.place();
    c.place();
    expect(sim.writes).toHaveLength(1);
  });

  // ── AND WHEN THE ENGINE PAYS ONLY SOME OF IT ──────────────────────────────
  // Not hypothetical. One hunt measured Chromium paying 1440 of 1920px above a
  // reader in a single frame — the remaining 480px is a painted backward jump,
  // which is the "sometimes it just jumps back randomly a bit" report. An
  // absolute row-based target handles this without knowing it happened: it pays
  // the remainder, whatever the remainder is.
  it('pays exactly the remainder when the engine pays only part of it', () => {
    const sim = new SimScroller(simRows(40), {
      paysAnchoring: true,
      anchoringFraction: 0.75,
      furnitureBelow: 100,
    });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsTo(3000);
    drainScroll(sim, c);
    const before = sim.rowOffset('m15');
    sim.writes.length = 0;

    sim.prepend(simRows(4, 400, 'old')); // 1600px above; the engine pays 1200
    c.place();
    drainScroll(sim, c);

    expect(sim.writes).toEqual([3000 + 1600]); // …and we pay the other 400
    expect(sim.rowOffset('m15')).toBe(before);
    expect(c.phase(true)).toBe('ANCHORED');
  });

  // ── WHERE ROW IDENTITY EARNS ITS PLACE ────────────────────────────────────
  // When the engine pays in FULL, `place()` finds the target already satisfied
  // and writes nothing — so there is no number for pixel identity to recognise,
  // and the last thing we wrote may be from minutes ago. The engine's own scroll
  // event then arrives completely unattributed. The only thing that can tell it
  // from a gesture is that the reader's ROW did not move, which is the entire
  // purpose of the adjustment.
  //
  // The consequence of getting it wrong is not a jump — the intent it would latch
  // onto is where the reader already is — it is STORE TRAFFIC: a record write per
  // adjustment, for a position that has not changed. That was a real bug in its
  // own right (constantly-rewritten rows sat at the fresh end of the LRU and
  // evicted the parked positions the store exists to keep), and it is what this
  // measures.
  it('an engine adjustment we did not have to correct writes no record', () => {
    const { sim, c } = parkedAt3000(true);
    const before = sim.rowOffset('m15');
    sim.prepend(simRows(3, 400, 'old'));
    c.place();
    expect(sim.writes).toEqual([]); // nothing to correct — the engine did it all
    expect(drainScroll(sim, c)).toBe(0); // …and nobody thinks the reader moved
    expect(sim.rowOffset('m15')).toBe(before);
  });

  it('…nor does a hundred of them', () => {
    const { sim, c } = parkedAt3000(true);
    let verdicts = 0;
    for (let i = 0; i < 100; i++) {
      sim.prepend(simRows(1, 200, `old${i}-`));
      c.place();
      verdicts += drainScroll(sim, c);
    }
    expect(sim.writes).toEqual([]);
    expect(verdicts).toBe(0);
  });

  it('…and a partial payment is not mistaken for the reader moving', () => {
    const sim = new SimScroller(simRows(40), {
      paysAnchoring: true,
      anchoringFraction: 0.5,
      furnitureBelow: 100,
    });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
    sim.writes.length = 0;
    sim.prepend(simRows(4, 400, 'old'));
    c.place();
    // The engine's own adjustment and our correction both produce scroll events.
    // Neither is the reader, so the intent must still name the message the store
    // does — not wherever the drift left them.
    expect(drainScroll(sim, c)).toBe(0);
    expect(c.intent()).toEqual({ at: 'row', id: 'm15', offset: -60 });
  });
});

describe('SEEKING — the message is not loaded', () => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    // A fresh mount opens on the server's tail: rows m20..m39 only.
    sim = new SimScroller(simRows(20, 200, 'tail'), { furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
  });

  // ── THE HONEST FLOOR ──────────────────────────────────────────────────────
  // This is where a ratio fallback used to place a guess. Measured: 0.0363 of a
  // 185,753px document (turn 40) applied to the 13,044px tail landed on turn
  // 296, the opposite end of the chat.
  it('does not move the reader at all while it cannot find the message', () => {
    // Still true, and it matters more now: the restore no longer pages, so an
    // unreachable anchor must not invent a position either. A ratio fallback
    // used to guess here — 0.0363 of a 185,753px document applied to the
    // 13,044px tail landed on turn 296, the opposite end of the chat.
    sim.readerScrollsTo(500);
    drainScroll(sim, c);
    const where = sim.scrollTop;
    c.dispatch({ t: 'shown', mem: PARKED('ancient', -120) });
    expect(sim.scrollTop).toBe(where);
    // …and it reports itself STRANDED rather than seeking, which is the caller's
    // cue to open at the newest message instead.
    expect(c.phase(true)).toBe('IDLE');
    expect(c.strandedRestore(true)).toBe(true);
  });

  it('a stranded restore is not silent — the caller can land it at the end', () => {
    // Without this the intent is merely unsatisfied: `place` computes no target,
    // writes no scrollTop, and a fresh list leaves the reader at the TOP of
    // whatever loaded rather than in the conversation.
    c.dispatch({ t: 'shown', mem: PARKED('ancient', -120) });
    expect(c.strandedRestore(true)).toBe(true);
    c.dispatch({ t: 'jump-to-latest' });
    drainScroll(sim, c);
    expect(c.phase(true)).toBe('FOLLOWING');
    expect(c.strandedRestore(true)).toBe(false);
  });

  it('is NOT stranded while the anchor could still arrive in the tail', () => {
    // Asked on every commit rather than once at mount: a tail that happens to
    // contain the remembered anchor satisfies the restore normally.
    c.dispatch({ t: 'shown', mem: PARKED('tail5', -40) });
    expect(c.strandedRestore(true)).toBe(false);
  });

  it('places the reader the moment the message arrives', () => {
    c.dispatch({ t: 'shown', mem: PARKED('ancient', -120) });
    sim.prepend([{ id: 'ancient', height: 300 }, ...simRows(4, 200, 'older')]);
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('ancient')).toBe(-120);
    expect(c.phase(true)).toBe('ANCHORED');
  });

  it('asks for NO pages at all — a restore is free or it does not happen', () => {
    // It used to spend the whole budget here, which is up to eight socket round
    // trips (~1 MB) before a reopened chat settled. Measured as the single
    // biggest cause of "opening a chat feels stuck".
    c.dispatch({ t: 'shown', mem: PARKED('ancient') });
    expect(c.wantsOlder(true)).toBe(false);
  });

  it('…but a SEARCH still pages for its destination, bounded', () => {
    // The budget did not go away, it moved to the intent that earns it: a hit
    // is a place the reader asked for by name, and paging to reach it is the
    // request rather than a convenience.
    c.dispatch({ t: 'search-jump' });
    let asked = 0;
    while (c.wantsOlder(true)) {
      asked++;
      c.dispatch({ t: 'sought' });
      if (asked > 100) throw new Error('unbounded');
    }
    expect(asked).toBe(SEEK_PAGE_BUDGET);
  });

  it('spends nothing when the server has said there is no more history', () => {
    c.dispatch({ t: 'search-jump' });
    expect(c.wantsOlder(false)).toBe(false);
  });

  // ── AND IT LEAVES THE RECORD ALONE ────────────────────────────────────────
  // The single most consequential property in the rewrite. When the seek gives
  // up, the reader's real parked message must still be in the store — otherwise
  // the next open starts from a worse position than this one did, which is what
  // made the landing point walk 4% -> 72% over eight reloads.
  it('leaves the stored record untouched when a SEARCH gives up', () => {
    // Unchanged in substance — only the intent that spends the budget moved. A
    // search that cannot reach its hit must not overwrite where the reader was
    // reading, or the next open starts from a worse position than this one did.
    c.dispatch({ t: 'shown', mem: PARKED('ancient', -120) });
    c.dispatch({ t: 'search-jump' });
    // The reader is somewhere else entirely — in the tail, where the document
    // opened — for the whole seek.
    while (c.wantsOlder(true)) c.dispatch({ t: 'sought' });
    expect(sim.anchorHere()?.id).not.toBe('ancient');
    // NOTHING is written, which is how the stored memory survives: `record`
    // returning null means "no update", so whatever the reader parked on is
    // still what the next open reads. Writing the row the mechanism ended up
    // sitting on is what the old retirement did, and what made every subsequent
    // open start from a worse position than this one.
    expect(c.record('s1')).toBeNull();
  });
});

// ── RE-ENTRY IS IDEMPOTENT ──────────────────────────────────────────────────
// The property the previous design could not hold. With the ratio in the store,
// eight reloads of one chat parked at 4% landed at 13, 21, 28, 42, 53, 62, 66
// and 72% — every open consumed a slightly larger fraction and recorded a larger
// one, with no fixed point short of the bottom. Five cold opens took the same
// reader from 4% to 67%.
describe('re-entry is idempotent', () => {
  function openOnce(mem: ChatScrollMem | null, reachable: boolean) {
    // ── "IN REACH" NOW MEANS "IN THE TAIL" ───────────────────────────────────
    // A restore no longer pages for a lost anchor, so this used to drive the
    // seek and prepend the row on page 3. The property being tested is
    // unchanged and still worth holding — re-entry is idempotent, and does not
    // walk — but "reachable" is now about what the server served, not about how
    // far we are willing to dig for it.
    const sim = new SimScroller(
      reachable
        ? [...simRows(10, 200, 'tail'), { id: 'parked', height: 300 }, ...simRows(9, 200, 'late')]
        : simRows(20, 200, 'tail'),
      { furnitureBelow: 100 },
    );
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem });
    // An unreachable restore lands at the end rather than hanging unsatisfied.
    if (c.strandedRestore(true)) c.dispatch({ t: 'jump-to-latest' });
    c.place();
    drainScroll(sim, c);
    return { sim, c, landedOn: sim.anchorHere()?.id ?? null, stored: c.record('s1') };
  }

  it('lands in the same place every time, when the message is out of reach', () => {
    // ── THE PROPERTY, AND THE HALF OF IT THAT CHANGED ───────────────────────
    // What this has always protected is that re-entry does not WALK: the old
    // retirement wrote whatever row the mechanism ended up on, and the landing
    // point drifted 4% → 72% over eight reloads.
    //
    // It no longer protects "the memory still names the parked message". That
    // was right while an unreachable anchor was something we kept trying for.
    // Now we take the reader to the newest message instead, and recording that
    // honestly is the point — a stored position we did not honour would send
    // the next open hunting for it again.
    let mem: ChatScrollMem | null = PARKED('parked', -120);
    const landings: (string | null)[] = [];
    for (let open = 0; open < 8; open++) {
      const r = openOnce(mem, false);
      landings.push(r.landedOn);
      mem = r.stored ?? mem;
    }
    expect(new Set(landings).size).toBe(1);
    // Caught up, with no anchor — "you are at the end", which is where we put
    // them. Not some arbitrary row the mechanism happened to stop on.
    expect(mem?.caughtUp).toBe(true);
    expect(mem?.anchorId).toBeNull();
  });

  it('lands on the message itself every time, when it IS in reach', () => {
    let mem: ChatScrollMem | null = PARKED('parked', -120);
    for (let open = 0; open < 5; open++) {
      const r = openOnce(mem, true);
      expect(r.sim.rowOffset('parked')).toBe(-120);
      mem = r.stored ?? mem;
    }
    expect(mem?.anchorId).toBe('parked');
  });
});

describe('the doors', () => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
  });

  it('a display:none hide and show puts the reader back', () => {
    expect(sim.rowOffset('m15')).toBe(-60);
    sim.hide();
    c.dispatch({ t: 'hidden' });
    sim.show();
    c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
    expect(sim.rowOffset('m15')).toBe(-60);
  });

  it('a hidden pane is never measured, and never writes', () => {
    sim.hide();
    c.dispatch({ t: 'hidden' });
    sim.writes.length = 0;
    c.place();
    expect(sim.writes).toEqual([]);
    // …and nothing about a zero-height pane is worth recording.
    expect(c.record('s1')).toBeNull();
  });

  // The load-bearing half of the zero-height guard. A hidden pane reports
  // clientHeight 0 and scrollHeight 0, so every measurement taken from it is a
  // lie — and the one that does lasting damage is a RECORD, because unlike a
  // scroll position it outlives the pane being shown again. The measured shape:
  // `display:none` zeroes the box, the oldest loaded row is nominally under the
  // viewport top, and storing that overwrote the reader's parked message.
  //
  // Note the write guard in `place()` is, by contrast, defence in depth: with
  // one writer and a re-place on `shown`, the simulation could not be made to
  // show a hidden-pane write causing lasting harm. It stays because being wrong
  // about it is cheap and finding out is not, but this test is the one with a
  // demonstrated victim — see the mutation notes in the commit.
  it('a zero-height pane cannot write a record over the reader’s parked message', () => {
    sim.hide();
    c.dispatch({ t: 'hidden' });
    // The oldest loaded row is nominally under the viewport top now.
    expect(c.record('s1')).toBeNull();
    sim.show();
    c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
    expect(c.record('s1')).toEqual(PARKED('m15', -60));
    expect(sim.rowOffset('m15')).toBe(-60);
  });

  // ── iOS ───────────────────────────────────────────────────────────────────
  // A WKWebView resumes with overflow scroll reset to 0 and fires an ordinary
  // scroll event for it. Geometry cannot tell that from the reader flicking to
  // the top: clientHeight is back and scrollTop is honestly 0. Believing it
  // wrote the oldest on-screen row over the reader's parked message — and the
  // restore then reproduced the corruption faithfully.
  it('an iOS resume that zeroes scrollTop does not corrupt the record', () => {
    sim.hide();
    c.dispatch({ t: 'hidden' });
    sim.iosResumeZeroesScroll();
    // The corrupting scroll event arrives BEFORE anything has been placed, and
    // it reports scrollTop 0 with the oldest loaded row under the viewport top.
    expect(sim.anchorHere()?.id).toBe('m0');
    expect(drainScroll(sim, c)).toBe(0);
    // The record still names the message the reader parked on — NOT `m0`, which
    // is what the old design wrote here and then faithfully restored.
    expect(c.record('s1')).toEqual(PARKED('m15', -60));
    // …and the reader is put back.
    c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
    expect(sim.rowOffset('m15')).toBe(-60);
  });
});

describe('the reader always wins', () => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(60), { furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
  });

  // Measured on the design this replaces: a drag-select autoscroll moved a
  // reader 2000 -> 9128px — 7128px of real motion — and produced ZERO reader
  // verdicts across 158 scroll events, because growth was arriving the whole
  // time. Keyboard paging was the same, 0 across 244. Neither device fires wheel
  // or touchmove, so the gesture listeners never saw them.
  it('is heard through a device no gesture listener sees, while content streams', () => {
    let verdicts = 0;
    for (let i = 0; i < 20; i++) {
      sim.append(simRows(1, 200, `live${i}-`)); // output arriving the whole time
      c.place();
      sim.readerScrollsBy(-350); // a device that fires no wheel and no touch
      verdicts += drainScroll(sim, c);
    }
    expect(verdicts).toBeGreaterThan(0);
    expect(c.phase(true)).toBe('ANCHORED');
  });

  it('a gesture during a placement is not undone by it', () => {
    c.dispatch({ t: 'shown', mem: PARKED('m40', -30) });
    expect(sim.rowOffset('m40')).toBe(-30);
    sim.readerScrollsBy(-2000);
    drainScroll(sim, c);
    const where = sim.scrollTop;
    // More content arrives, so every subscription fires again…
    sim.append(simRows(3, 200, 'live'));
    c.place();
    drainScroll(sim, c);
    // …and nothing springs them back to the remembered message.
    expect(sim.scrollTop).toBe(where);
  });

  it('their position is what gets stored, not the one we were restoring to', () => {
    c.dispatch({ t: 'shown', mem: PARKED('m40', -30) });
    sim.readerScrollsTo(1000);
    drainScroll(sim, c);
    const rec = c.record('s1');
    expect(rec?.anchorId).toBe(sim.anchorHere()?.id);
    expect(rec?.anchorId).not.toBe('m40');
  });
});

// ── THE TWO THRESHOLDS ARE NOT ONE THRESHOLD ────────────────────────────────
// "Should live output scroll itself into view while I watch?" is a 40px question
// answered continuously. "Had I finished the conversation?" is a 160px question
// answered once, when I leave. Collapsing them is the bug that stranded a reader
// 5701px up: one wheel notch (~120px, a single trackpad nudge to re-read the
// last line) is past the first and inside the second, and persisting the first
// as the second stored "parked on the newest message" — harmless until a
// ten-minute turn landed thirty messages.
//
// A mutation sweep found this had no test: widening FOLLOW_THRESHOLD_PX from 40
// to 160 left the whole suite green.
describe('the live-follow threshold is not the re-entry threshold', () => {
  function nudgedUp(px: number) {
    const sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsBy(-px);
    drainScroll(sim, c);
    return { sim, c };
  }

  it('a one-notch nudge stops the log following, and is still caught up', () => {
    const { c } = nudgedUp(120);
    // Live output must NOT drag them back down…
    expect(c.phase(true)).not.toBe('FOLLOWING');
    // …and tomorrow they still open at the newest message, because they had read
    // to the end.
    expect(c.record('s1')).toEqual(RETIRED);
  });

  it('…and live output really does leave them alone', () => {
    const { sim, c } = nudgedUp(120);
    const before = sim.anchorHere();
    for (let i = 0; i < 5; i++) {
      sim.append(simRows(1, 300, `live${i}-`));
      c.place();
      drainScroll(sim, c);
    }
    expect(sim.anchorHere()).toEqual(before);
  });

  it('a reader who scrolled properly away is neither', () => {
    const { c } = nudgedUp(4000);
    expect(c.phase(true)).toBe('ANCHORED');
    expect(c.record('s1')?.caughtUp).toBe(false);
  });

  it('resting at the end is both', () => {
    const sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    expect(c.phase(true)).toBe('FOLLOWING');
    expect(c.record('s1')).toEqual(RETIRED);
  });
});

// ── THE BOTTOM 40 PIXELS WERE A DEAD ZONE ───────────────────────────────────
// The threshold above is right about live output and was wrong about the reader.
// Applied to a gesture, it swallowed it: at the end of the log, any upward move
// that did not clear 40px in ONE event landed back inside the band, read as
// "still following", and was written straight back to the bottom — in the same
// turn as the reader's own scroll event, so nothing was ever painted at the new
// position. Not a jump. No movement at all.
//
// Measured in Chrome against the live chat, from a reader parked at the end:
//
//     upward notch    net movement    writes
//        10 px            0 px          1
//        25 px            0 px          1
//        39 px            0 px          1
//        45 px           45 px          0
//        80 px           80 px          0
//
// Reported as "if I go all the way to the bottom of this chat and try to scroll
// back it resists" — which is what a page that does not move feels like when you
// are pushing it.
//
// The number is not the fix; DIRECTION is. Lowering it only shrinks the dead
// zone, because a trackpad ramps from 1–2px and any threshold eats the start of
// a slow gesture. A reader who moved AWAY from the end is not following at any
// distance, and the band keeps the only job it was right about — letting a move
// back DOWN regain following without landing on the exact pixel.
describe('an upward gesture is never swallowed by the follow band', () => {
  function atEndThenUp(px: number) {
    const sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    expect(c.phase(true)).toBe('FOLLOWING'); // parked at the end, following
    const from = sim.scrollTop;
    sim.readerScrollsBy(-px);
    drainScroll(sim, c);
    // Whatever else happens, a later commit must not reel them in either.
    sim.append(simRows(1, 200, 'live'));
    c.place();
    drainScroll(sim, c);
    return { moved: from - sim.scrollTop, phase: c.phase(true), c, sim };
  }

  // Every one of these was 0px before the fix.
  //
  // Starts at 2px, not 1: a ONE-pixel move is below the discriminator's noise
  // floor (TARGET_EPSILON, in `scrollEventIsTheReader`) and is attributed to
  // layout rather than to the reader — deliberately, because fractional
  // geometry produces 1px deltas that nobody made. That floor is a different
  // decision from this one and it is not what the reported resistance was: a
  // trackpad is past 1px within the first event or two of any real gesture.
  for (const px of [2, 10, 25, 39]) {
    it(`keeps a ${px}px nudge — the whole of it`, () => {
      const r = atEndThenUp(px);
      expect(r.moved).toBe(px);
      expect(r.phase).not.toBe('FOLLOWING');
    });
  }

  // The far side of the old threshold, which always worked. Here so a
  // regression that re-broke the small notches by breaking the large ones
  // cannot pass.
  for (const px of [45, 400]) {
    it(`still keeps a ${px}px scroll`, () => {
      expect(atEndThenUp(px).moved).toBe(px);
    });
  }

  it('a 2px nudge is still CAUGHT UP — this fixes resistance, not the memory', () => {
    // The two thresholds stay separate. Nudging a couple of pixels off the end
    // must not park the reader in history tomorrow; that is the 160px question
    // and it is still answered separately (see the block above).
    //
    // No append here, unlike the helper: 200px of new output below a reader who
    // has stopped following puts them 202px from the end, which is genuinely not
    // caught up. That is the append's doing, not the nudge's, and conflating the
    // two would make this assertion about the wrong thing.
    const sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsBy(-2);
    drainScroll(sim, c);
    expect(c.phase(true)).not.toBe('FOLLOWING');
    expect(c.record('s1')).toEqual(RETIRED);
  });

  it('scrolling back DOWN regains following without hitting the exact pixel', () => {
    const { c, sim } = atEndThenUp(400);
    expect(c.phase(true)).not.toBe('FOLLOWING');
    // Short of the end by less than the band — the band's actual job.
    sim.readerScrollsTo(sim.maxScrollTop - 20);
    drainScroll(sim, c);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('an ENGINE adjustment is not mistaken for the reader going backwards', () => {
    // A prepend the engine pays for moves scrollTop DOWNWARD-in-number terms by
    // growing the document above. If that unrecorded move became the baseline
    // for the next real gesture, the direction test would be describing the
    // engine's move rather than the reader's.
    const sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.prepend(simRows(5, 200, 'older'));
    c.place();
    drainScroll(sim, c);
    // Now a move back DOWN to the end. It must read as following.
    sim.readerScrollsToEnd();
    drainScroll(sim, c);
    expect(c.phase(true)).toBe('FOLLOWING');
  });
});

// ── IDLE MUST NOT BE AN ABSORBING STATE ─────────────────────────────────────
// Found by an acceptance run in a real browser, behind a green unit suite.
//
// `placed` is the causal gate: the discriminator believes no scroll event until
// something has been placed since the pane became visible, because an iOS resume
// fires a scroll event reporting 0 that geometry cannot tell from a gesture.
// `place()` used to set it only on the two branches that computed a target — so
// while the intent was `{ at: 'nothing' }` (the transcript has not arrived, or
// the remembered message is not loaded) the gate never opened, every scroll
// event read as layout, and the reader could not be heard AT ALL.
//
// Measured consequence in the browser: parking wrote no store key, the pane
// paged its entire history because nothing ever said "this reader is following",
// and a thumbnail burst left the reader 2,640px short with `writes: 0`.
//
// The gate's honest meaning is "have we read the layout yet", not "did we move
// anybody" — a pane with nothing to assert has still been measured.
describe('a pane with nothing to assert still hears the reader', () => {
  function idlePane() {
    const sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.place(); // the commit subscription, with no memory read yet
    return { sim, c };
  }

  it('hears a gesture while the intent is still “we do not know”', () => {
    const { sim, c } = idlePane();
    expect(c.intent()).toEqual({ at: 'nothing' });
    sim.readerScrollsTo(3000);
    expect(drainScroll(sim, c)).toBe(1);
    expect(c.intent()).toMatchObject({ at: 'row' });
  });

  it('…and stores where they chose to be', () => {
    const { sim, c } = idlePane();
    sim.readerScrollsTo(3000);
    drainScroll(sim, c);
    expect(c.record('s1')).toMatchObject({ caughtUp: false, sid: 's1' });
    expect(c.record('s1')?.anchorId).toBe(sim.anchorHere()?.id);
  });

  it('…and follows the tail once they reach it', () => {
    const { sim, c } = idlePane();
    sim.readerScrollsToEnd();
    drainScroll(sim, c);
    expect(c.phase(true)).toBe('FOLLOWING');
    // …which is what the pager consults, so a chat nobody has scrolled does not
    // page its whole history in.
    sim.append(simRows(1, 300, 'img-'));
    c.place();
    sim.resizeRow('img-0', 2400);
    drainScroll(sim, c);
    c.place();
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });

  // The seek is the other way to sit on `{ at: 'nothing' }` for a long time.
  it('hears a gesture in the middle of a seek it cannot finish', () => {
    const sim = new SimScroller(simRows(20, 200, 'tail'), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: PARKED('ancient', -120) });
    while (c.wantsOlder(true)) c.dispatch({ t: 'sought' });
    sim.readerScrollsTo(500);
    expect(drainScroll(sim, c)).toBe(1);
    // …and their choice replaces the goal they told us to stop hunting.
    expect(c.record('s1')?.anchorId).not.toBe('ancient');
  });
});

// ── A SEARCH HIT THAT IS NOT LOADED YET ─────────────────────────────────────
// Acceptance regression: every search case that needed older history failed.
// The jump could only enter the `hit` state once the target message was already
// rendered — which is precisely what the seek exists to achieve — so it never
// paged, the banner appeared immediately, and "Keep looking" reached nothing.
// Measured: `rows: 126` before and after, `hit: null`.
//
// A hit is therefore named by the DOM (`[data-search-hit]`), not by an id the
// mechanism holds, because when the seek starts nobody knows the id.
describe('a search jump seeks history for a hit it cannot see yet', () => {
  function jumped() {
    // A fresh mount on the tail; the hit is 4 pages back.
    const sim = new SimScroller(simRows(20, 200, 'tail'), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: null });
    c.dispatch({ t: 'search-jump' });
    return { sim, c };
  }

  it('asks for older history while the hit is not rendered', () => {
    const { c } = jumped();
    expect(c.phase(true)).toBe('SEEKING');
    expect(c.wantsOlder(true)).toBe(true);
  });

  it('does not move the reader while it is hunting', () => {
    const { sim, c } = jumped();
    const onScreen = sim.anchorHere();
    sim.writes.length = 0;
    c.dispatch({ t: 'sought' });
    sim.prepend(simRows(4, 200, 'older'));
    c.place();
    // The mechanism asserts nothing — measured as writes, not as scrollTop,
    // because the ENGINE moves scrollTop for a prepend and that is not us.
    expect(sim.writes).toEqual([]);
    // …and the reader is left on the row they were reading.
    expect(sim.anchorHere()).toEqual(onScreen);
  });

  it('places the hit a third down the moment it arrives', () => {
    const { sim, c } = jumped();
    c.dispatch({ t: 'sought' });
    // Rows BEFORE the hit as well as after it: a hit at the very top of the
    // document cannot be put a third of the way down, and clamping there is
    // correct rather than a failure.
    sim.prepend([
      ...simRows(3, 200, 'before'),
      { id: 'hit', height: 300 },
      ...simRows(3, 200, 'after'),
    ]);
    sim.hitId = 'hit';
    c.place();
    expect(sim.rowOffset('hit')).toBe(Math.round(sim.clientHeight / 3));
    expect(c.phase(true)).toBe('ANCHORED');
    expect(c.wantsOlder(true)).toBe(false);
  });

  it('gives up inside the budget rather than paging forever', () => {
    const { c } = jumped();
    let asked = 0;
    while (c.wantsOlder(true)) {
      asked++;
      c.dispatch({ t: 'sought' });
      if (asked > 100) throw new Error('unbounded');
    }
    expect(asked).toBe(SEEK_PAGE_BUDGET);
    // …and having given up, it still records nothing over the reader's memory.
    expect(c.record('s1')).toBeNull();
  });

  it('"keep looking" gets a fresh budget', () => {
    const { c } = jumped();
    while (c.wantsOlder(true)) c.dispatch({ t: 'sought' });
    expect(c.wantsOlder(true)).toBe(false);
    c.dispatch({ t: 'search-jump' });
    expect(c.wantsOlder(true)).toBe(true);
  });
});

// ── "I LOOKED AND COULD NOT FIND IT" IS NOT "I NEVER LOOKED" ────────────────
// The banner cannot tell those apart and the reader cannot either, so the
// give-up path has to be able to. Measured in a browser: `rows` and `first`
// identical before and after a jump, the banner up immediately, and not one
// page requested — reported to the reader as "further back than the history
// loaded here", which is a claim about the conversation made by code that never
// asked the server anything.
describe('giving up on a hit is a fact about the search, not a default', () => {
  function hunting() {
    const sim = new SimScroller(simRows(20, 200, 'tail'), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: null });
    c.dispatch({ t: 'search-jump' });
    return { sim, c };
  }

  it('has not given up before it has asked', () => {
    const { c } = hunting();
    expect(c.spentSeekBudget()).toBe(false);
    expect(c.wantsOlder(true)).toBe(true);
  });

  it('…nor part way through', () => {
    const { c } = hunting();
    c.dispatch({ t: 'sought' });
    c.dispatch({ t: 'sought' });
    expect(c.spentSeekBudget()).toBe(false);
  });

  it('has given up once the budget is spent', () => {
    const { c } = hunting();
    for (let i = 0; i < SEEK_PAGE_BUDGET; i++) c.dispatch({ t: 'sought' });
    expect(c.spentSeekBudget()).toBe(true);
  });

  // The distinction that matters: a pane that never entered the hit state, or
  // one whose seek never ran, must not report a spent budget — otherwise "we
  // looked eight pages back" is said on behalf of zero requests.
  it('a pane that never sought has not spent anything', () => {
    const sim = new SimScroller(simRows(20, 200, 'tail'), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: null });
    expect(c.spentSeekBudget()).toBe(false);
  });

  it('a fresh jump has not given up, however much the last one spent', () => {
    const { c } = hunting();
    for (let i = 0; i < SEEK_PAGE_BUDGET; i++) c.dispatch({ t: 'sought' });
    expect(c.spentSeekBudget()).toBe(true);
    c.dispatch({ t: 'search-jump' });
    expect(c.spentSeekBudget()).toBe(false);
  });
});

/**
 * A RESTORE MUST NOT GIVE UP BEFORE THERE IS ANYTHING TO LOOK IN.
 *
 * `strandedRestore` converts "this restore can never land" into "open at the
 * newest message", and the caller asks it on EVERY commit — including the
 * first, when the list is still empty. So a reload declared the restore
 * unreachable before a single row existed, pinned the reader to the bottom,
 * and then rendered the row they wanted a moment later.
 *
 * Measured on a reload of a real chat before the fix: the remembered row came
 * back as row 15 of 29 with `caughtUp: false` in the record, and the reader
 * was at the very bottom. It had not failed to find the row — it had given up
 * before looking. After: the same message at the top, at offset -523 against
 * a recorded -523.
 */
describe('a restore arriving before its transcript', () => {
  it('is not stranded while the list is empty', () => {
    const sim = new SimScroller([], { furnitureBelow: 0 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
    // Nothing has rendered. Absence here is not evidence of absence.
    expect(c.strandedRestore(true)).toBe(false);
    expect(c.strandedRestore(false)).toBe(false);
  });

  it('lands once the tail carrying the row arrives', () => {
    const sim = new SimScroller([], { furnitureBelow: 0 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: PARKED('m15', -60) });
    sim.append(simRows(40));
    c.place();
    drainScroll(sim, c);
    expect(c.strandedRestore(true)).toBe(false);
    expect(sim.rowOffset('m15')).toBe(-60);
  });

  it('IS stranded once rows exist and the row is not among them', () => {
    // The other half: the opening tail arrived in one commit and the row is
    // not in it, so the reader belongs at the newest message rather than
    // wherever an unplaced list happens to start.
    const sim = new SimScroller(simRows(10), { furnitureBelow: 0 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: PARKED('nope-not-here', -60) });
    expect(c.strandedRestore(true)).toBe(true);
  });
});

/**
 * CHASING THE BOTTOM WHILE IT RUNS AWAY FROM YOU.
 *
 * "Sometimes when there are a bunch of pending messages in a chat I can't
 * scroll down, at least on mobile, and the only way is clicking the down
 * button." Queued messages and the reply they provoke append at the bottom on
 * every commit, so a reader dragging downward is moving toward a target that
 * is moving away — and every one of those commits calls `place()` while the
 * drag is still in flight.
 *
 * The property that has to hold is that each drag is KEPT. If appends could
 * cancel them the reader would be pinned, which is the report; if they are
 * kept the reader closes on the bottom at the speed of their own thumb and
 * the button is a convenience rather than the only way.
 */
describe('scrolling down while messages append', () => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    // Park a long way up, then start pulling back down.
    sim.readerScrollsTo(1000);
    drainScroll(sim, c);
  });

  it('keeps every downward drag, even as rows land below on each commit', () => {
    const start = sim.scrollTop;
    let asked = 0;
    for (let i = 0; i < 20; i++) {
      sim.readerScrollsBy(300);
      asked += 300;
      // A pending message, then the agent's reply to it — two commits that
      // both grow the document below the reader.
      sim.append(simRows(1, 120, `q${i}-`));
      c.place();
      sim.append(simRows(1, 240, `a${i}-`));
      c.place();
      drainScroll(sim, c);
    }
    // Every pixel the reader asked for arrived. Appends below them must not
    // move them at all, so this is exact rather than approximate.
    expect(sim.scrollTop).toBe(start + asked);
  });

  it('and still reaches the end rather than stalling short of it', () => {
    for (let i = 0; i < 60; i++) {
      sim.readerScrollsBy(600);
      sim.append(simRows(1, 150, `n${i}-`));
      c.place();
      drainScroll(sim, c);
      if (sim.scrollTop >= sim.maxScrollTop) break;
    }
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
    // …and having arrived, they are FOLLOWING again, so the next message
    // carries them with it instead of leaving them one row short forever.
    expect(c.phase(false)).toBe('FOLLOWING');
  });
});

// ── A QUEUED MESSAGE DRAINING ──────────────────────────────────────────────
// Reported as "when I have pending messages at the bottom of a chat and I try
// to scroll down it won't let me scroll down all the way and it goes into a
// jumpy frenzy".
//
// A drain makes the document SHORTER for a moment: the pending row, with its
// edit and cancel buttons, is removed, and the turn that replaces it starts
// smaller. A reader sitting at the bottom is clamped up by the engine to the
// new maximum — measured on a live chat with six messages queued, scrollTop
// 5227 -> 5182 as the maximum went 5227 -> 5182, with no write from the
// controller involved at all.
//
// `place()` has always known that a clamped shrink is layout rather than a
// gesture. `onScroll()` did not, so the clamp was read as "they scrolled up":
// following was dropped, the reader was parked just above the tail, and when
// the content re-grew they were stranded there — with every later drain doing
// it again, which is the frenzy.
describe('a shrink under a reader at the end', () => {
  function atEndThen(shrinkPx: number) {
    const sim = new SimScroller(simRows(40), { furnitureBelow: 300 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    expect(c.phase(true)).toBe('FOLLOWING');
    // The pending row goes away: the document gets shorter under them.
    sim.setFurniture(300 - shrinkPx);
    drainScroll(sim, c);
    c.place();
    drainScroll(sim, c);
    return { c, sim };
  }

  it('keeps following — the floor came up, nobody moved away', () => {
    const { c } = atEndThen(45);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('is still following after a big drain, not just a small one', () => {
    const { c } = atEndThen(220);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('and is carried to the new bottom when the turn renders and it regrows', () => {
    // The stranding is what made it impossible to scroll down "all the way":
    // the content came back, the reader did not.
    const { c, sim } = atEndThen(45);
    sim.setFurniture(300);
    c.place();
    drainScroll(sim, c);
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('still lets a REAL upward gesture stop the following', () => {
    // The fix must not swallow the thing the test above it exists for: moving
    // away from the tail is the reader's decision and outranks any arithmetic.
    const sim = new SimScroller(simRows(40), { furnitureBelow: 300 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsBy(-120);
    drainScroll(sim, c);
    expect(c.phase(true)).not.toBe('FOLLOWING');
  });
});

// ── SENDING TAKES YOU TO WHAT YOU SENT ──────────────────────────────────────
// "When you post a message to a chat that has persistent cards I don't think it
// fully scrolls all the way down to make the agent's 'working…' indicator
// visible — it's hidden by the persistent card."
//
// Measured in Chromium, two pinned cards, composer wrap 228px: a reader 60px
// above the end pressed Enter, the end moved 3001 -> 3112, scrollTop stayed at
// 2941, and the working line's bottom sat at y=735 under a wrap starting at
// y=572. Nothing was mis-measured — the reserve was right on every frame. The
// send simply never said "follow", and an append below an ANCHORED reader is
// correctly a no-op. 228px of cards and composer is the furniture here.
describe.each(ENGINES)('a send follows to the end — $name', ({ paysAnchoring }) => {
  const COMPOSER_WITH_CARDS = 228;
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(40), { furnitureBelow: COMPOSER_WITH_CARDS, paysAnchoring });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    drainScroll(sim, c);
    // Close enough to the bottom to look like it, far enough to be ANCHORED.
    sim.readerScrollsBy(-60);
    drainScroll(sim, c);
  });

  /** Where the newest row's bottom sits relative to the composer's top edge;
   *  positive means it is behind the cards. */
  const hiddenBehindComposer = (id: string): number =>
    sim.rowOffset(id) + 111 - (sim.clientHeight - COMPOSER_WITH_CARDS);

  it('without a send, an append below an anchored reader moves nothing', () => {
    // The reason `sent` has to exist: this is right for streaming you are not
    // reading, and it is exactly what hid your own message.
    const top = sim.scrollTop;
    sim.append([{ id: 'reply', height: 111 }]);
    c.place();
    drainScroll(sim, c);
    expect(sim.scrollTop).toBe(top);
    expect(hiddenBehindComposer('reply')).toBeGreaterThan(0);
  });

  it('the bubble and the working line land clear of the cards', () => {
    c.dispatch({ t: 'sent' });
    sim.append([{ id: 'mine', height: 111 }]);
    c.place();
    drainScroll(sim, c);
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
    expect(hiddenBehindComposer('mine')).toBeLessThanOrEqual(0);
    expect(c.phase(true)).toBe('FOLLOWING');
  });
});
