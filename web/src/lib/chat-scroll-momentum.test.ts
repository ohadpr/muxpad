import { beforeEach, describe, expect, it } from 'vitest';
import { ChatScrollController } from './chat-scroll-controller';
import { SimScroller, simRows } from './chat-scroll-sim';

const RETIRED = { anchorId: null, anchorOffset: 0, caughtUp: true, sid: 's1' };
function drainScroll(sim: SimScroller, c: ChatScrollController): number {
  let n = 0;
  while (sim.takeScrollEvent()) {
    c.onScroll();
    n++;
  }
  return n;
}

/**
 * MOMENTUM: THE READER IS STILL MOVING AND NOTHING SAYS SO.
 *
 * After a finger lifts, iOS and Android keep the content gliding for up to a
 * second or two and fire NO wheel, NO touchmove and NO key — only `scroll`.
 * So the input signal is silent for the part of the gesture that covers the
 * most distance, and scrolling UP is exactly when older history prepends.
 */
describe.each([
  ['engine pays nothing', 0],
  ['engine pays half', 0.5],
  ['engine pays in full', 1],
])('a glide meeting a prepend — %s', (_name, fraction) => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(60), {
      paysAnchoring: fraction > 0,
      ...(fraction > 0 && fraction < 1 ? { anchoringFraction: fraction } : {}),
      furnitureBelow: 100,
    });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsTo(4000);
    drainScroll(sim, c);
  });

  it('keeps the glide, because history waits for it to finish', () => {
    const before = sim.rowOffset('m30');
    sim.touchDown();
    sim.glideBy(-120); // movement with no input event behind it
    // History arrives mid-glide. The caller asks `readerIsMoving()` and holds
    // it back, so nothing is inserted and the document stands still.
    expect(c.readerIsMoving()).toBe(true);
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m30')).toBe(before + 120);

    // The gesture ends; now it lands, in one commit, and must not move them.
    sim.motionEnds();
    const afterGlide = sim.rowOffset('m30');
    sim.prepend(simRows(4, 300, 'old'));
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m30')).toBe(afterGlide);
  });

  it('a long glide across many frames keeps every pixel', () => {
    const before = sim.rowOffset('m30');
    sim.touchDown();
    let asked = 0;
    for (let i = 0; i < 25; i++) {
      sim.glideBy(-90);
      asked += 90;
      c.place(); // a commit on every frame, as live output produces
      drainScroll(sim, c);
    }
    sim.motionEnds();
    expect(sim.rowOffset('m30')).toBe(before + asked);
  });

  it('does not mistake the prepend itself for the reader gliding', () => {
    const before = sim.rowOffset('m30');
    sim.prepend(simRows(4, 300, 'old'));
    c.place();
    drainScroll(sim, c);
    expect(sim.rowOffset('m30')).toBe(before);
  });
});

/**
 * AND THE BUFFER MUST NOT BECOME A LEAK.
 *
 * Holding history back is only safe if it is actually released. These are the
 * ways "defer" turns into "never".
 */
describe('the deferral itself', () => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    sim = new SimScroller(simRows(60), { paysAnchoring: true, furnitureBelow: 100 });
    c = new ChatScrollController(sim);
    c.dispatch({ t: 'mounted' });
    c.dispatch({ t: 'shown', mem: RETIRED });
    sim.readerScrollsTo(4000);
    drainScroll(sim, c);
  });

  it('reports motion only while there is motion', () => {
    expect(c.readerIsMoving()).toBe(false);
    sim.touchDown();
    expect(c.readerIsMoving()).toBe(true);
    sim.motionEnds();
    expect(c.readerIsMoving()).toBe(false);
  });

  it('a WHEEL reader is never considered in motion', () => {
    // Desktop already works: the wheel reports the reader's travel directly,
    // so there is nothing to defer and no reason to make history wait.
    sim.readerScrollsBy(-300);
    drainScroll(sim, c);
    expect(c.readerIsMoving()).toBe(false);
  });

  it('appends during a glide are NOT deferred — they do not move the reader', () => {
    // Only growth ABOVE the reader collides with a gesture. Live output below
    // must keep arriving, or a chat goes mute every time somebody scrolls.
    const before = sim.rowOffset('m30');
    sim.touchDown();
    sim.glideBy(-120);
    sim.append(simRows(3, 200, 'new'));
    c.place();
    drainScroll(sim, c);
    sim.motionEnds();
    expect(sim.rowOffset('m30')).toBe(before + 120);
  });
});
