import { beforeEach, describe, expect, it } from 'vitest';
import { ChatScrollController } from './chat-scroll-controller';
import { type SimRow, SimScroller, simRows } from './chat-scroll-sim';

const RETIRED = { anchorId: null, anchorOffset: 0, caughtUp: true, sid: 's1' };
const drain = (sim: SimScroller, c: ChatScrollController) => {
  let n = 0;
  while (sim.takeScrollEvent()) {
    c.onScroll();
    n++;
  }
  return n;
};

/**
 * THE TEMPORAL CONTRACT.
 *
 * Every defect in this area has been an ORDERING defect, not an arithmetic
 * one: a commit and a scroll event describing the same frame, arriving in
 * either order, and the code reaching a different answer depending on which
 * came first. The adversarial review named the acceptance criteria directly —
 * "remove the possibility that event order chooses between erasing reader
 * movement and persisting layout drift" — and these are those criteria.
 *
 * They are invariants, not scenarios: each one should hold for ANY engine
 * anchoring fraction and ANY interleaving.
 */
function harness(fraction: number) {
  const sim = new SimScroller(simRows(60), {
    paysAnchoring: fraction > 0,
    ...(fraction > 0 && fraction < 1 ? { anchoringFraction: fraction } : {}),
    furnitureBelow: 100,
  });
  const c = new ChatScrollController(sim);
  c.dispatch({ t: 'mounted' });
  c.dispatch({ t: 'shown', mem: RETIRED });
  sim.readerScrollsTo(4000);
  drain(sim, c);
  sim.writes.length = 0;
  return { sim, c };
}

const FRACTIONS: [string, number][] = [
  ['pays nothing', 0],
  ['pays half', 0.5],
  ['pays in full', 1],
];

describe.each(FRACTIONS)('temporal invariants — engine %s', (_name, fraction) => {
  let sim: SimScroller;
  let c: ChatScrollController;
  beforeEach(() => {
    ({ sim, c } = harness(fraction));
  });

  it('writes NOTHING while the reader is in motion', () => {
    // A passive write during a gesture is a fight the reader always notices
    // and never wins. Nothing may touch the position until they stop.
    sim.touchDown();
    for (let i = 0; i < 20; i++) {
      sim.glideBy(-100);
      c.place();
      drain(sim, c);
    }
    expect(sim.writes).toEqual([]);
  });

  it('…including while output appends below them', () => {
    sim.touchDown();
    for (let i = 0; i < 10; i++) {
      sim.glideBy(-100);
      sim.append(simRows(1, 180, `n${i}-`));
      c.place();
      drain(sim, c);
    }
    expect(sim.writes).toEqual([]);
  });

  it('reaches the same place whichever order the frame arrives in', () => {
    // THE defect class. One frame, two deliveries, two orders.
    const commitFirst = harness(fraction);
    commitFirst.sim.prepend(simRows(3, 300, 'old'));
    commitFirst.c.place();
    drain(commitFirst.sim, commitFirst.c);

    const scrollFirst = harness(fraction);
    scrollFirst.sim.prepend(simRows(3, 300, 'old'));
    drain(scrollFirst.sim, scrollFirst.c);
    scrollFirst.c.place();

    expect(commitFirst.sim.rowOffset('m30')).toBe(scrollFirst.sim.rowOffset('m30'));
    expect(commitFirst.sim.scrollTop).toBe(scrollFirst.sim.scrollTop);
  });

  it('never replays a movement it already accounted for', () => {
    // Placing twice for one frame must not pay twice — the double-pay this
    // whole design exists to avoid.
    const before = sim.rowOffset('m30');
    sim.prepend(simRows(3, 300, 'old'));
    c.place();
    c.place();
    c.place();
    drain(sim, c);
    expect(sim.rowOffset('m30')).toBe(before);
  });

  it('a gesture that ends does not un-end a newer one', () => {
    // A stale completion arriving late must not declare the reader still.
    sim.touchDown();
    sim.glideBy(-200);
    sim.motionEnds();
    sim.touchDown(); // a second flick starts immediately
    sim.glideBy(-200);
    c.place();
    drain(sim, c);
    expect(c.readerIsMoving()).toBe(true);
    expect(sim.writes).toEqual([]);
  });

  it('holds the reader through growth that arrives while they are still', () => {
    // The other half: not moving means the compensation DOES apply.
    const before = sim.rowOffset('m30');
    sim.prepend(simRows(4, 250, 'old'));
    c.place();
    drain(sim, c);
    expect(sim.rowOffset('m30')).toBe(before);
  });
});

/**
 * AND THE DEFERRAL MUST TERMINATE.
 *
 * Buffering older history during a gesture is only safe if the buffer is
 * bounded and always drains. "Defer" turning into "never" is the failure mode
 * the review flagged, and one version of this genuinely produced it — pages
 * piled up behind the buffer until a single flush moved 127,000px.
 */
describe('the deferral terminates', () => {
  it('motion always ends, even if the position never settles', () => {
    const { sim, c } = harness(1);
    sim.touchDown();
    sim.glideBy(-50);
    expect(c.readerIsMoving()).toBe(true);
    sim.motionEnds();
    expect(c.readerIsMoving()).toBe(false);
  });

  it('a flushed batch leaves the reader where the gesture left them', () => {
    const { sim, c } = harness(1);
    sim.touchDown();
    let asked = 0;
    for (let i = 0; i < 12; i++) {
      sim.glideBy(-120);
      asked += 120;
      c.place();
      drain(sim, c);
    }
    sim.motionEnds();
    const landed = sim.rowOffset('m30');
    // Everything held back arrives at once, as one commit.
    const held: SimRow[] = simRows(12, 300, 'old');
    sim.prepend(held);
    c.place();
    drain(sim, c);
    // The batch lands and moves them not at all, and the whole gesture is
    // still accounted for — a deferral that loses travel is no better than
    // the collision it avoids.
    expect(sim.rowOffset('m30')).toBe(landed);
    expect(sim.scrollTop).toBe(4000 - asked + 12 * 300);
  });
});
