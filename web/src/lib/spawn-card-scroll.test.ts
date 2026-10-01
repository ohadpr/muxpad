/**
 * THE SPAWN CARDS, DRIVEN THROUGH THE SCROLL MECHANISM.
 *
 * ── THE BUG THIS FILE EXISTS FOR ─────────────────────────────────────────────
 * "scroll on mobile has a regression I think. When I scroll up sometimes it
 * jumps back."
 *
 * Nothing in `chat-scroll*.ts` had changed. What had changed was the identity of
 * the rows it was given. `ChatPane` drew a spawn card's `data-eid` as
 * `spawn-<child tab id>` / `done-<child tab id>`, which is unique for exactly as
 * long as a worker has one launch and one completion — and `spawn_rounds` (v32,
 * `e129c4c`) made a worker a SEQUENCE of jobs, so one child now draws a pair of
 * entries PER ROUND. Every pair reused the same two ids. Measured on the real
 * database: one child with 27 rounds, i.e. 27 rows in one log all answering to
 * `spawn-<id>`, plus 27 answering to `done-<id>`.
 *
 * The mechanism names the reader's place with a row id (`{ at: 'row', id }`) and
 * resolves it with `rowBox`, which returns the FIRST row carrying that id — in
 * the DOM (`chat-scroll-dom.ts`) and in the sim alike. So a duplicate is not a
 * weak anchor, it is a WRONG one: the reader's offset is measured against the
 * card they are looking at and replayed against a different card entirely, and
 * the distance between the two is how far they get thrown. It fires off their own
 * scroll event, which is why it reads as the scroll fighting back.
 *
 * ── WHY THE TEST IS AT THIS SEAM ─────────────────────────────────────────────
 * Neither half can see it alone. `chat-mention.test.ts` knew the cards were
 * right — they were, as ENTRIES; it had no opinion about their ids.
 * `chat-scroll-controller.test.ts` knew the mechanism was right — it is, given
 * unique ids, and every row in the sim had a distinct one because a test author
 * writing `simRows(20)` gets `m0…m19` for free. The defect lived in the JOIN, so
 * this file takes the ids `spawnCards` actually produces, builds the log
 * `ChatPane` actually draws out of them, and scrolls a reader through it.
 *
 * Asserted under both engine settings because it has nothing to do with scroll
 * anchoring: the wrong number is computed before any engine is asked to pay
 * anything, so a WebKit with no anchoring at all and a Chromium with it are
 * thrown identically. (The reporter is on an installed iOS PWA, which is the
 * no-anchoring case.)
 */
import { describe, expect, it } from 'vitest';
import type { SpawnRound } from '../../../shared/src/types';
import type { MentionChat, SpawnCard } from './chat-mention';
import { canExpandSpawn, resolveSpawnAnchor, spawnCards, spawnState } from './chat-mention';
import { ChatScrollController } from './chat-scroll-controller';
import type { SimRow } from './chat-scroll-sim';
import { SimScroller } from './chat-scroll-sim';

/** Both shipping engine configurations — see `chat-scroll-sim`'s header. */
const ENGINES = [
  { name: 'engine pays (Chromium, Safari 27)', paysAnchoring: true },
  { name: 'engine pays nothing (iOS 26 and earlier)', paysAnchoring: false },
] as const;

const CAUGHT_UP = { anchorId: null, anchorOffset: 0, caughtUp: true, sid: 's1' };

const KID: MentionChat = {
  tabId: 'kid',
  tabName: 'dead-css',
  workspaceSlug: 'personal',
  tabSlug: 'dead-css',
  paneIds: ['pane-kid'],
  parentId: 'parent',
  createdAt: 1_000,
  done: true,
  doneReason: 'delivered',
  doneAt: 9_000,
} as unknown as MentionChat;

/** `n` closed rounds for the one child — the shape the real database is in. */
function rounds(n: number): Map<string, SpawnRound[]> {
  return new Map([
    [
      'kid',
      Array.from({ length: n }, (_, i) => ({
        id: `round-${i}`,
        tab_id: 'kid',
        started_at: 1_000 + i * 1_000,
        ended_at: 1_500 + i * 1_000,
        report: `Round ${i} found something.`,
        report_state: 'ok',
        artifacts: [],
      })) as unknown as SpawnRound[],
    ],
  ]);
}

const ROW = 200;
const PROSE = 300;

/**
 * The log `ChatPane` draws: two prose rows, then a card, repeating — cards
 * interleaved into the transcript by time, which is what `interleaveSpawnCards`
 * does and the reason a card can sit ABOVE the reader at all.
 *
 * Returns the row list plus the document `top` of each card, so the assertions
 * can say where the reader is without restating the arithmetic.
 */
function logOf(cards: SpawnCard[]): { rows: SimRow[]; cardTop: number[] } {
  const rows: SimRow[] = [];
  const cardTop: number[] = [];
  let top = 0;
  cards.forEach((card, i) => {
    rows.push({ id: `m${i}a`, height: PROSE }, { id: `m${i}b`, height: PROSE });
    top += PROSE * 2;
    cardTop.push(top);
    rows.push({ id: card.anchorId, height: ROW });
    top += ROW;
  });
  // Room below, so the interesting cards are inside the scrollable range rather
  // than pinned against the bottom by the clamp.
  rows.push({ id: 'tail', height: 2_000 });
  return { rows, cardTop };
}

describe('a card per round gets an id per round', () => {
  it('keeps the round verdict and artifacts when the child moves on', () => {
    const history = rounds(2);
    const first = history.get('kid')![0]!;
    first.artifacts = ['https://example.test/A'];
    const kid = { ...KID, status: 'working' as const, report: { text: 'B', state: 'crashed' as const, at: 9000 }, artifacts: ['B'] };
    const card = spawnCards([kid], 'parent', 12, history).find((c) => c.kind === 'completion')!;
    expect(spawnState(spawnCards([kid], 'parent', 12, history)[0]!.chat)).toBe('delivered');
    expect(spawnState(card.chat)).toBe('delivered');
    expect(canExpandSpawn(card.chat)).toBe(true);
    expect(card.chat.artifacts).toEqual(first.artifacts);
    first.report_state = null;
    first.report = null;
    const missing = spawnCards([kid], 'parent', 12, history).find((c) => c.kind === 'completion')!;
    expect(missing.chat.report).toBeUndefined();
    expect(canExpandSpawn(missing.chat)).toBe(false);
  });

  it('maps legacy launch and completion anchors to distinct historical rows', () => {
    const history = rounds(3);
    const cards = spawnCards([KID], 'parent', 12, history);
    const launch = resolveSpawnAnchor('spawn-kid', history);
    const completion = resolveSpawnAnchor('done-kid', history);
    expect(launch).toBe(cards[0]?.anchorId);
    expect(completion).toBe(cards.at(-1)?.anchorId);
    expect(resolveSpawnAnchor(launch, history)).toBe(launch);
  });

  it('keeps the live offset when fallback rows acquire round identities', () => {
    const sim = new SimScroller([{ id: 'before', height: 1000 },
      { id: 'spawn-kid', height: 100 }, { id: 'after', height: 2000 }]);
    const c = new ChatScrollController(sim);
    c.dispatch({ t: 'shown', mem: { anchorId: 'spawn-kid', anchorOffset: -20, caughtUp: false, sid: 's1' } });
    const to = resolveSpawnAnchor('spawn-kid', rounds(1));
    sim.rows[1]!.id = to;
    c.dispatch({ t: 'anchor-renamed', from: 'spawn-kid', to });
    sim.resizeRow('before', 1300);
    c.place();
    expect(sim.rowOffset(to)).toBe(-20);
    expect(c.wantsOlder(true)).toBe(false);
    expect(c.record('s1')?.anchorId).toBe(to);
  });

  it('draws six DISTINCT rows for three rounds', () => {
    // The direct statement of the invariant. Pre-fix this was six entries under
    // two ids: `spawn-kid` three times and `done-kid` three times.
    const cards = spawnCards([KID], 'parent', 12, rounds(3));
    const ids = cards.map((c) => c.anchorId);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('keeps the UNSUFFIXED id for the tab-level fallback', () => {
    // The corpus arrives before the rounds do, and an older server has no such
    // route. That path is still one pair per child, so it keeps the ids every
    // already-parked scroll position was written against.
    expect(spawnCards([KID], 'parent').map((c) => c.anchorId)).toEqual(['spawn-kid', 'done-kid']);
  });

  it('is STABLE across renders — an anchor that moves is not an anchor', () => {
    // A round id is a server-stamped primary key, so this is a property of the
    // data and not of the render. If it were derived from the entry's index the
    // ids would shift every time a round was added, and every stored position
    // would silently name a different card.
    const once = spawnCards([KID], 'parent', 12, rounds(4)).map((c) => c.anchorId);
    expect(spawnCards([KID], 'parent', 12, rounds(4)).map((c) => c.anchorId)).toEqual(once);
    // …and adding a fifth round leaves the first four alone.
    expect(
      spawnCards([KID], 'parent', 12, rounds(5))
        .map((c) => c.anchorId)
        .slice(0, 8),
    ).toEqual(once);
  });
});

describe('scrolling up past a later round does not jump', () => {
  for (const engine of ENGINES) {
    it(`leaves the reader where they scrolled (${engine.name})`, () => {
      const cards = spawnCards([KID], 'parent', 12, rounds(3));
      const { rows, cardTop } = logOf(cards);
      const sim = new SimScroller(rows, { clientHeight: 800, ...engine });
      const c = new ChatScrollController(sim);
      c.dispatch({ t: 'mounted' });
      c.dispatch({ t: 'shown', mem: CAUGHT_UP });

      // The reader flicks up until the LAST card's top is 50px above the
      // viewport top — they are reading round three's completion.
      const want = (cardTop[cardTop.length - 1] as number) + 50;
      sim.readerScrollsTo(want);
      expect(sim.scrollTop).toBe(want);

      // Their own scroll event is delivered. Pre-fix, the id under their eyes
      // resolved to ROUND ONE's card 3,200px further up, so the controller
      // "restored" them to it: one flick up, and the log threw them back into
      // history. Nothing here should move at all — they are already where they
      // asked to be.
      while (sim.takeScrollEvent()) c.onScroll();
      expect(sim.scrollTop).toBe(want);
      expect(sim.writes).toEqual([sim.maxScrollTop]); // the open-at-the-end write, and no other
    });

    it(`holds them there when a card lands above them (${engine.name})`, () => {
      // The half that is the reader's actual complaint: an insert ABOVE the
      // viewport is routine in this log — a sibling finishing, a round closing,
      // a browser moment arriving — and the anchor is the only thing that stops
      // it shifting the page. Resolved to the wrong card, the compensation is
      // computed for a row 3,200px away and the insert moves the reader instead.
      const cards = spawnCards([KID], 'parent', 12, rounds(3));
      const { rows, cardTop } = logOf(cards);
      const sim = new SimScroller(rows, { clientHeight: 800, ...engine });
      const c = new ChatScrollController(sim);
      c.dispatch({ t: 'mounted' });
      c.dispatch({ t: 'shown', mem: CAUGHT_UP });

      const want = (cardTop[cardTop.length - 1] as number) + 50;
      sim.readerScrollsTo(want);
      while (sim.takeScrollEvent()) c.onScroll();
      const readingNow = sim.anchorHere();

      // A sibling's completion card arrives between round one and round two —
      // 400px of new content above the reader, from an async update they did not
      // ask for. The commit subscription calls `place()`.
      sim.rows.splice(3, 0, { id: 'done-sibling', height: 400 });
      c.place();
      while (sim.takeScrollEvent()) c.onScroll();

      // Same card, same offset: the insert paid for itself and the reader did
      // not move relative to what they were reading.
      expect(sim.anchorHere()).toEqual(readingNow);
      expect(sim.scrollTop).toBe(want + 400);
    });
  }
});
