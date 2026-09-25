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

describe('FOLLOWING', () => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(40), { furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
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
    sim.readerScrollsTo(500);
    drainScroll(sim, c);
    const where = sim.scrollTop;
    c.dispatch({ t: 'shown', mem: PARKED('ancient', -120) });
    expect(sim.scrollTop).toBe(where);
    expect(c.phase(true)).toBe('SEEKING');
  });

  it('places the reader the moment the message arrives', () => {
    c.dispatch({ t: 'shown', mem: PARKED('ancient', -120) });
    sim.prepend([{ id: 'ancient', height: 300 }, ...simRows(4, 200, 'older')]);
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('ancient')).toBe(-120);
    expect(c.phase(true)).toBe('ANCHORED');
  });

  it('asks for pages, bounded, and stops', () => {
    c.dispatch({ t: 'shown', mem: PARKED('ancient') });
    let asked = 0;
    while (c.wantsOlder(true)) {
      asked++;
      c.dispatch({ t: 'sought' });
      if (asked > 100) throw new Error('unbounded');
    }
    expect(asked).toBe(SEEK_PAGE_BUDGET);
    expect(c.phase(true)).toBe('IDLE');
  });

  it('spends nothing when the server has said there is no more history', () => {
    c.dispatch({ t: 'shown', mem: PARKED('ancient') });
    expect(c.wantsOlder(false)).toBe(false);
  });

  // ── AND IT LEAVES THE RECORD ALONE ────────────────────────────────────────
  // The single most consequential property in the rewrite. When the seek gives
  // up, the reader's real parked message must still be in the store — otherwise
  // the next open starts from a worse position than this one did, which is what
  // made the landing point walk 4% -> 72% over eight reloads.
  it('leaves the stored record untouched when it gives up', () => {
    const original = PARKED('ancient', -120);
    c.dispatch({ t: 'shown', mem: original });
    // The reader is somewhere else entirely — in the tail, where the document
    // opened — for the whole seek.
    while (c.wantsOlder(true)) c.dispatch({ t: 'sought' });
    expect(sim.anchorHere()?.id).not.toBe('ancient');
    // …and the record STILL names the message they parked on. Not the row the
    // mechanism ended up sitting on, which is what the old retirement wrote and
    // what made every subsequent open start from a worse position than this one.
    expect(c.record('s1')).toEqual(original);
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
    // A fresh mount opens on the tail, exactly as the server serves it.
    const sim = new SimScroller(simRows(20, 200, 'tail'), { furnitureBelow: 100 });
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem });
    // The seek runs to exhaustion, paging in history that does (or does not)
    // contain the anchor.
    let pages = 0;
    while (c.wantsOlder(true)) {
      c.dispatch({ t: 'sought' });
      sim.prepend(
        reachable && pages === 2
          ? [{ id: 'parked', height: 300 }, ...simRows(3, 200, `p${pages}-`)]
          : simRows(4, 200, `p${pages}-`),
      );
      c.place();
      drainScroll(sim, c);
      pages++;
    }
    return { sim, c, landedOn: sim.anchorHere()?.id ?? null, stored: c.record('s1') };
  }

  it('lands on the same row every time, when the message is out of reach', () => {
    let mem: ChatScrollMem | null = PARKED('parked', -120);
    const landings: (string | null)[] = [];
    for (let open = 0; open < 8; open++) {
      const r = openOnce(mem, false);
      landings.push(r.landedOn);
      // Whatever the mechanism stored is what the next open reads. If it stored
      // nothing, the original memory stands — which is the point.
      mem = r.stored ?? mem;
    }
    expect(new Set(landings).size).toBe(1);
    // …and the memory still names the message the reader actually parked on,
    // eight opens later.
    expect(mem?.anchorId).toBe('parked');
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
