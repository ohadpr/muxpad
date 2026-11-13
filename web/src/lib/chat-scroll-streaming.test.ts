/**
 * Scrolling WHILE THE DOCUMENT IS CHANGING: a reply streaming in, a queue
 * draining. The owner's words: "scrolling gets stuck/weird. It especially/only
 * happens when I have QUEUED MESSAGES or when the agent is STILL TYPING A LONG
 * MESSAGE."
 *
 * Every test here drives the sim's split input/motion verbs (`wheel`,
 * `compositorApplies`, `inputOnly`) — see the block above them in
 * chat-scroll-sim.ts. The atomic `readerScrollsBy` cannot express any of these
 * failures, which is how ~3,900 lines of scroll tests stayed green while
 * real Chromium measured:
 *
 *   · 1px trackpad deltas ×80 while streaming: moved 0px, 79 writes;
 *   · 300px of wheel while streaming: moved 390–450px, exact when still;
 *   · a nudge up inside a reply taller than the viewport: thrown 2100px up to
 *     the last finished message, and walled there.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatScrollMem } from './chat-scroll';
import { ChatScrollController } from './chat-scroll-controller';
import { SimScroller, simRows } from './chat-scroll-sim';

const RETIRED: ChatScrollMem = { anchorId: null, anchorOffset: 0, caughtUp: true, sid: 's1' };

function drainScroll(sim: SimScroller, c: ChatScrollController): void {
  while (sim.takeScrollEvent()) c.onScroll();
}

/** A chat following its tail, with a reply streaming into unanchored furniture. */
function streamingChat(opts: { furnitureBelow?: number; clientHeight?: number } = {}) {
  const sim = new SimScroller(simRows(40), { furnitureBelow: 100, ...opts });
  const c = new ChatScrollController(sim);
  c.dispatch({ t: 'mounted' });
  c.dispatch({ t: 'shown', mem: RETIRED });
  drainScroll(sim, c);
  /** One streamed token: the live tail grows, the commit's layout effect places. */
  const token = (px = 12) => {
    sim.setFurniture(sim.furnitureBelow + px);
    c.place();
  };
  return { sim, c, token };
}

describe.each([
  { delta: 0.5, events: 80 },
  { delta: 1, events: 80 },
  { delta: 1.5, events: 80 },
])('a slow trackpad gesture ($delta px per event) while the agent types', ({ delta, events }) => {
  // THE "STUCK". The input arrives, a streaming commit places before the
  // compositor has moved `scrollTop`, and the old mechanism read a sub-1px input
  // as noise, zeroed it at the end of the place, and re-wrote the end — undoing
  // the pixel the browser then scrolled. 0px moved over 79 writes, in Chromium.
  it('moves the page exactly as far as the reader pushed it, with no writes', () => {
    const { sim, c, token } = streamingChat();
    const from = sim.scrollTop;
    const writes = sim.writes.length;
    for (let i = 0; i < events; i++) {
      sim.wheel(-delta);
      token(); // the commit lands between the input and its motion
      sim.compositorApplies();
      drainScroll(sim, c);
      token();
    }
    expect(from - sim.scrollTop).toBeCloseTo(delta * events, 6);
    expect(sim.writes.length).toBe(writes);
    expect(c.intent().at).toBe('row');
  });

  it('…and the same when the input event arrives AFTER its own scroll', () => {
    // The other ordering Chromium was measured producing: the compositor has
    // already moved `scrollTop` and delivered the scroll event when the wheel
    // event reaches the page.
    const { sim, c, token } = streamingChat();
    const from = sim.scrollTop;
    for (let i = 0; i < events; i++) {
      sim.wheel(-delta).compositorApplies();
      drainScroll(sim, c);
      token();
    }
    expect(from - sim.scrollTop).toBeCloseTo(delta * events, 6);
    expect(c.intent().at).toBe('row');
  });
});

describe('a 1px nudge is heard by the scroll event too, not only by a commit', () => {
  // Both entry points weigh the same evidence. With nothing streaming no
  // place() runs, so the scroll event is the only one that can hear it.
  it('stops following and reports the reader at once', () => {
    const { sim, c } = streamingChat();
    sim.wheel(-1).compositorApplies();
    let verdicts = 0;
    while (sim.takeScrollEvent()) if (c.onScroll()) verdicts++;
    expect(verdicts).toBe(1);
    expect(c.phase(true)).not.toBe('FOLLOWING');
  });
});

describe('the wheel delta is applied once, by the browser', () => {
  // THE OVERSHOOT. `place()` wrote `sawTop + shift + intent` while the browser
  // had not yet applied the delta, and the browser then applied it on top of
  // the write. 300px of wheel moved 390–450px while streaming.
  it('300px of wheel moves 300px while streaming — input first, then a commit, then motion', () => {
    const { sim, c, token } = streamingChat();
    sim.readerScrollsBy(-1000); // leave the tail first: this is about distance, not the band
    drainScroll(sim, c);
    const from = sim.scrollTop;
    for (let i = 0; i < 60; i++) {
      sim.wheel(-5);
      token();
      sim.compositorApplies();
      drainScroll(sim, c);
    }
    expect(from - sim.scrollTop).toBe(300);
  });

  it('…and DOWN as well', () => {
    const { sim, c, token } = streamingChat();
    sim.readerScrollsBy(-2000);
    drainScroll(sim, c);
    const from = sim.scrollTop;
    for (let i = 0; i < 60; i++) {
      sim.wheel(5);
      token();
      sim.compositorApplies();
      drainScroll(sim, c);
    }
    expect(sim.scrollTop - from).toBe(300);
  });

  it('…and when the input lands after its own scroll event', () => {
    const { sim, c, token } = streamingChat();
    sim.readerScrollsBy(-1000);
    drainScroll(sim, c);
    const from = sim.scrollTop;
    for (let i = 0; i < 10; i++) {
      // The compositor scrolls and the scroll event is handled; only then does
      // the wheel event reach the page, and a commit follows it.
      sim.scrollTopSilently(sim.scrollTop - 30);
      drainScroll(sim, c);
      sim.inputOnly(-30);
      token();
    }
    expect(from - sim.scrollTop).toBe(300);
  });

  it('a key press is evidence of WHO, never of how far', () => {
    // PageUp records -40 in the listener; the browser animates a whole page
    // over several frames. A commit inside the animation used to write the 40.
    const { sim, c, token } = streamingChat();
    sim.readerScrollsBy(-1000);
    drainScroll(sim, c);
    const from = sim.scrollTop;
    sim.inputOnly(-40);
    token();
    for (let i = 0; i < 4; i++) {
      sim.scrollTopSilently(sim.scrollTop - 150);
      drainScroll(sim, c);
      token();
    }
    expect(from - sim.scrollTop).toBe(600);
  });
});

describe('a reader pushing TOWARD the end keeps following', () => {
  // At the bottom, wheel-down cannot move anything, so it is input with no
  // motion — and a trackpad fling that lands at the bottom keeps sending
  // momentum wheel events for about a second. Read as "the reader moved, here
  // is where they are", the next growth left them behind and following ended.
  it('wheel-down at the end while output arrives does not detach', () => {
    const { sim, c, token } = streamingChat();
    for (let i = 0; i < 10; i++) {
      sim.inputOnly(10);
      token(120);
      drainScroll(sim, c);
    }
    expect(c.phase(true)).toBe('FOLLOWING');
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
  });
});

describe('a gesture absorbed by a queue-drain clamp is still the reader’s', () => {
  // The engine applies the wheel and then clamps to the new, lower maximum, so
  // `scrollTop` ends at the end. "At the end after a shrink" is layout only when
  // nobody touched anything — here somebody pushed up.
  it('stops following', () => {
    const { sim, c } = streamingChat({ furnitureBelow: 300 });
    sim.wheel(-30).compositorApplies();
    sim.setFurniture(300 - 45);
    c.place();
    drainScroll(sim, c);
    expect(c.phase(true)).not.toBe('FOLLOWING');
  });
});

describe('a follower nobody touched still follows', () => {
  // The guard rail on all of the above: no input, no motion, the tail is
  // followed exactly as before — including through a drain that clamps.
  let sim: SimScroller;
  let c: ChatScrollController;
  let token: (px?: number) => void;
  beforeEach(() => {
    ({ sim, c, token } = streamingChat({ furnitureBelow: 300 }));
  });

  it('through a long stream', () => {
    for (let i = 0; i < 200; i++) {
      token(7.25);
      drainScroll(sim, c);
    }
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
    expect(c.phase(true)).toBe('FOLLOWING');
  });

  it('through a drain that shrinks the tail and a turn that regrows it', () => {
    sim.setFurniture(240);
    c.place();
    drainScroll(sim, c);
    token(400);
    drainScroll(sim, c);
    expect(sim.scrollTop).toBe(sim.maxScrollTop);
    expect(c.phase(true)).toBe('FOLLOWING');
  });
});

describe.each([
  { name: 'a long reply streaming', clientHeight: 800, furnitureBelow: 3000 },
  { name: 'a phone with a tall queued stack', clientHeight: 500, furnitureBelow: 650 },
])('reading INSIDE a tail taller than the viewport — $name', ({ clientHeight, furnitureBelow }) => {
  // The streaming turn and the queued rows carry no `data-eid`, so once the
  // viewport top is inside them the anchor is the last FINISHED row at a large
  // negative offset — honestly measured. The stale-offset rule for RESTORES
  // read that as "this offset no longer fits the row", threw it away, and put
  // the top of that row (usually the reader's own message) under their eyes.
  // Measured in the sim on production code: wanted 5900, got 3800.
  it('a nudge up stays a nudge, and the stream keeps appending below', () => {
    const { sim, c, token } = streamingChat({ clientHeight, furnitureBelow });
    const from = sim.scrollTop;
    const writes = sim.writes.length;
    sim.wheel(-80);
    token();
    sim.compositorApplies();
    drainScroll(sim, c);
    for (let i = 0; i < 20; i++) {
      token();
      drainScroll(sim, c);
    }
    expect(from - sim.scrollTop).toBe(80);
    expect(sim.writes.length).toBe(writes);
    expect(c.phase(true)).toBe('ANCHORED');
  });

  it('and scrolling back down through the reply is not walled at the last row', () => {
    const { sim, c, token } = streamingChat({ clientHeight, furnitureBelow });
    const up = Math.min(600, furnitureBelow - clientHeight + 50);
    const end = sim.maxScrollTop;
    sim.readerScrollsBy(-up);
    drainScroll(sim, c);
    expect(sim.scrollTop).toBe(end - up);
    const from = sim.scrollTop;
    for (let i = 0; i < 4; i++) {
      sim.readerScrollsBy(20);
      drainScroll(sim, c);
      token();
      drainScroll(sim, c);
    }
    expect(sim.scrollTop - from).toBe(80);
  });
});

describe('…and a RESTORE of that offset still gets the stale-offset clamp', () => {
  // The other half of the separation, end to end. A REMEMBERED offset that
  // does not fit its row is discarded exactly as before — the rule that keeps
  // a run which came back collapsed from pinning the reader to the bottom
  // (chat-scroll.ts, `scrollTopForAnchor`). Only the live intent changed.
  it('a remembered offset past its row is replayed as the top of that row', () => {
    const { sim, c } = streamingChat({ furnitureBelow: 3000 });
    sim.readerScrollsBy(-500);
    drainScroll(sim, c);
    const mem = c.record('s1');
    expect(mem?.anchorId).toBe('m39');
    expect(mem?.anchorOffset).toBe(-1900); // honestly past the 200px row's bottom
    c.dispatch({ t: 'hidden' });
    sim.hide();
    // The reply finished and landed as rows of its own; the tail is gone.
    sim.setFurniture(100);
    sim.append(simRows(3, 1000, 'reply'));
    sim.show();
    c.dispatch({ t: 'shown', mem });
    drainScroll(sim, c);
    expect(sim.rowOffset('m39')).toBe(0);
  });
});
