import { describe, expect, it } from 'vitest';
import type { ChatScrollMem } from './chat-scroll';
import {
  IDLE_STATE,
  SEEK_PAGE_BUDGET,
  type ScrollInput,
  type ScrollState,
  alreadyThere,
  canSeek,
  intentFor,
  next,
  phase,
  recordFor,
  scrollEventIsTheReader,
  shouldPageOlder,
  targetFor,
} from './chat-scroll-intent';

/** A parked memory — the case with something to lose. */
function parked(over: Partial<ChatScrollMem> = {}): ChatScrollMem {
  return { anchorId: 'evt#40', anchorOffset: -120, caughtUp: false, sid: 's1', ...over };
}
const retired: ChatScrollMem = {
  anchorId: null,
  anchorOffset: 0,
  caughtUp: true,
  sid: 's1',
};

/** Drive the machine from IDLE through a list of inputs. */
function drive(...inputs: ScrollInput[]): ScrollState {
  return inputs.reduce(next, IDLE_STATE);
}

const VIEWPORT = { scrollTop: 0, scrollHeight: 20_000, clientHeight: 800 };

describe('intentFor — the whole re-entry policy', () => {
  it('opens a caught-up reader at the newest message', () => {
    expect(intentFor(retired)).toEqual({ at: 'end' });
  });

  it('opens a reader with no memory at the newest message', () => {
    expect(intentFor(null)).toEqual({ at: 'end' });
  });

  it('puts a parked reader back on the message they were reading', () => {
    expect(intentFor(parked())).toEqual({ at: 'row', id: 'evt#40', offset: -120 });
  });

  // A row that names no message cannot place anyone, and the alternative to
  // saying so is inventing a position — which is the whole family of bug this
  // rewrite exists to kill.
  it('treats a row with no anchor as the newest message, not as a parked reader', () => {
    expect(intentFor(parked({ anchorId: null }))).toEqual({ at: 'end' });
  });
});

describe('the four states', () => {
  const loaded = { rowLoaded: true, hasMoreOlder: true };
  const missing = { rowLoaded: false, hasMoreOlder: true };

  it('FOLLOWING when the intent is the end', () => {
    expect(phase(drive({ t: 'shown', mem: retired }), loaded)).toBe('FOLLOWING');
  });

  it('ANCHORED when the intent names a row that is loaded', () => {
    expect(phase(drive({ t: 'shown', mem: parked() }), loaded)).toBe('ANCHORED');
  });

  it('SEEKING when it names one that is not, and history remains', () => {
    expect(phase(drive({ t: 'shown', mem: parked() }), missing)).toBe('SEEKING');
  });

  it('IDLE when the message is unreachable — history exhausted', () => {
    const s = drive({ t: 'shown', mem: parked() });
    expect(phase(s, { rowLoaded: false, hasMoreOlder: false })).toBe('IDLE');
  });

  it('IDLE when the message is unreachable — budget spent', () => {
    let s = drive({ t: 'shown', mem: parked() });
    for (let i = 0; i < SEEK_PAGE_BUDGET; i++) s = next(s, { t: 'sought' });
    expect(phase(s, missing)).toBe('IDLE');
  });

  it('IDLE with nothing asserted at all', () => {
    expect(phase(IDLE_STATE, loaded)).toBe('IDLE');
  });
});

describe('the seek budget', () => {
  const missing = { rowLoaded: false, hasMoreOlder: true };

  it('is bounded — a lost anchor must not drag a whole transcript over the wire', () => {
    let s = drive({ t: 'shown', mem: parked() });
    let sent = 0;
    while (canSeek(s, missing)) {
      sent++;
      s = next(s, { t: 'sought' });
      if (sent > 100) throw new Error('unbounded seek');
    }
    expect(sent).toBe(SEEK_PAGE_BUDGET);
  });

  it('stops the moment the row arrives', () => {
    const s = drive({ t: 'shown', mem: parked() }, { t: 'sought' });
    expect(canSeek(s, { rowLoaded: true, hasMoreOlder: true })).toBe(false);
  });

  it('never asks when the server has said there is no more history', () => {
    const s = drive({ t: 'shown', mem: parked() });
    expect(canSeek(s, { rowLoaded: false, hasMoreOlder: false })).toBe(false);
  });

  it('never asks for an intent that names no row', () => {
    expect(canSeek(drive({ t: 'shown', mem: retired }), missing)).toBe(false);
    expect(canSeek(IDLE_STATE, missing)).toBe(false);
  });

  // ── The measured bug this replaces ────────────────────────────────────────
  // The old counter was a local of the restore effect, and the effect re-ran on
  // every visibility transition — a browser-tab switch, an iOS backgrounding, a
  // screen unlock. So three tab switches spent 24 `load-older` round trips
  // (~3 MB) hunting the same unreachable message, not 8.
  it('is NOT re-spent on every visibility flip', () => {
    let s = drive({ t: 'shown', mem: parked() });
    let sent = 0;
    for (let flip = 0; flip < 4; flip++) {
      while (canSeek(s, missing)) {
        sent++;
        s = next(s, { t: 'sought' });
        if (sent > 100) throw new Error('unbounded seek');
      }
      s = next(s, { t: 'hidden' });
      s = next(s, { t: 'shown', mem: parked() });
    }
    expect(sent).toBe(SEEK_PAGE_BUDGET);
  });

  it('…but a fresh mount is a fresh visit', () => {
    let s = drive({ t: 'shown', mem: parked() });
    for (let i = 0; i < SEEK_PAGE_BUDGET; i++) s = next(s, { t: 'sought' });
    expect(canSeek(s, missing)).toBe(false);
    s = next(s, { t: 'mounted' });
    s = next(s, { t: 'shown', mem: parked() });
    expect(canSeek(s, missing)).toBe(true);
  });

  // A search is a destination the reader asked for just now. Refusing to page
  // for it because an earlier restore spent the budget would make the search
  // silently do nothing.
  it('a new search jump gets a fresh budget', () => {
    let s = drive({ t: 'shown', mem: parked() });
    for (let i = 0; i < SEEK_PAGE_BUDGET; i++) s = next(s, { t: 'sought' });
    s = next(s, { t: 'search-jump', id: 'evt#hit' });
    expect(canSeek(s, missing)).toBe(true);
  });
});

describe('targetFor — the one target computation', () => {
  it('the end is the bottom of the scrollable range', () => {
    expect(targetFor({ at: 'end' }, VIEWPORT, null)).toBe(19_200);
  });

  it('“we do not know” moves nobody', () => {
    expect(targetFor({ at: 'nothing' }, VIEWPORT, null)).toBeNull();
  });

  // The honest rule, and the reason there is no ratio: a row we do not have
  // cannot place anyone, and the alternative is a guess.
  it('a row we have not loaded moves nobody', () => {
    expect(targetFor({ at: 'row', id: 'evt#40', offset: -120 }, VIEWPORT, null)).toBeNull();
    expect(targetFor({ at: 'hit', id: 'evt#40' }, VIEWPORT, null)).toBeNull();
  });

  it('puts the anchored row back where it was', () => {
    // The row's top is 300px below the viewport top; it belongs 120px above it.
    const t = targetFor(
      { at: 'row', id: 'evt#40', offset: -120 },
      { ...VIEWPORT, scrollTop: 5000 },
      { top: 300, height: 400 },
    );
    expect(t).toBe(5420);
  });

  // ── IDEMPOTENCE, which is what makes one owner safe ───────────────────────
  // Every answer is absolute and derived from live geometry, so applying it
  // after an engine with scroll anchoring has already put the row back is a
  // no-op that the caller declines to write. A height DELTA cannot be made safe
  // this way: it would pay the same growth twice.
  it('asks for nothing where the engine already paid', () => {
    const geo = { ...VIEWPORT, scrollTop: 5000 };
    const t = targetFor({ at: 'row', id: 'evt#40', offset: -120 }, geo, {
      top: -120,
      height: 400,
    });
    expect(t).toBe(5000);
    expect(alreadyThere(t as number, geo.scrollTop)).toBe(true);
  });

  it('pays in full where it did not', () => {
    // 450px of growth above a parked reader that nothing compensated: the row
    // that belonged at -120 is now at +330.
    const geo = { ...VIEWPORT, scrollTop: 5000 };
    const t = targetFor({ at: 'row', id: 'evt#40', offset: -120 }, geo, { top: 330, height: 400 });
    expect(t).toBe(5450);
    expect(alreadyThere(t as number, geo.scrollTop)).toBe(false);
  });

  it('ignores growth BELOW the reader, which a height delta would not', () => {
    // The document grew 3000px at the end; the anchored row has not moved.
    const grown = { scrollTop: 5000, scrollHeight: 23_000, clientHeight: 800 };
    const t = targetFor({ at: 'row', id: 'evt#40', offset: -120 }, grown, {
      top: -120,
      height: 400,
    });
    expect(t).toBe(5000);
  });

  it('discards an offset that no longer fits the row it names', () => {
    // An action run the reader was 799px inside comes back collapsed to 26px.
    // Replaying the offset would put them 799px past a row they never finished;
    // the honest answer is its top, under their eyes.
    const geo = { ...VIEWPORT, scrollTop: 5000 };
    const t = targetFor({ at: 'row', id: 'g', offset: -799 }, geo, { top: 0, height: 26 });
    expect(t).toBe(5000);
  });

  it('places a search hit a third of the way down, not at the top', () => {
    const t = targetFor(
      { at: 'hit', id: 'evt#h' },
      { ...VIEWPORT, scrollTop: 1000 },
      {
        top: 600,
        height: 40,
      },
    );
    // 1000 + 600 - 800/3
    expect(t).toBe(1333);
  });
});

describe('scrollEventIsTheReader', () => {
  const here = { id: 'evt#40', offset: -120 };

  it('blames the reader for motion we did not cause', () => {
    expect(
      scrollEventIsTheReader({
        wrote: 5000,
        scrollTop: 3800,
        here: { id: 'evt#12', offset: -40 },
        was: here,
        placed: true,
      }),
    ).toBe(true);
  });

  // ── Our own write arriving late ───────────────────────────────────────────
  // The follow-bottom owner computes the bottom inside its callback and assigns
  // it; the scroll event that assignment produces is dispatched a frame later.
  // When a burst of lazy thumbnails all finish in one layout pass, more content
  // lands in between — measured: a write of 24910 against scrollHeight 25774,
  // two more screenshots decoded in the same pass (27934), event dispatched
  // 2160px from a bottom that had moved. Reading that as a gesture un-pinned a
  // reader who had not moved a pixel, permanently, 3/3 on two trees.
  it('does not blame them for our own write arriving against a document that grew', () => {
    expect(
      scrollEventIsTheReader({
        wrote: 24_910,
        scrollTop: 24_910,
        here: { id: 'evt#900', offset: -10 },
        was: here,
        placed: true,
      }),
    ).toBe(false);
  });

  // ── The engine ────────────────────────────────────────────────────────────
  // Scroll anchoring writes scrollTop during layout and stamps nothing, so a
  // pixel test cannot see it — measured at about one burst in six. But the whole
  // purpose of the adjustment is that the reader's row does not move.
  it('does not blame them for a scroll-anchoring adjustment', () => {
    expect(
      scrollEventIsTheReader({
        wrote: 3000,
        scrollTop: 3438, // the engine paid 438px of growth above
        here,
        was: here, // …and the row did not move
        placed: true,
      }),
    ).toBe(false);
  });

  // ── The case the union guard this replaces got wrong ──────────────────────
  // Its first condition was `!userScrolled` — a flag set by the first wheel
  // event of a visit and cleared only on hide, and set EXPLICITLY by the
  // jump-to-latest button. After one nudge, or one tap of the button that means
  // "follow the tail again", it was disarmed for the rest of the visit and the
  // burst bug came back verbatim: measured 0/3 and 1/3. Row identity carries no
  // state, so there is nothing to disarm.
  it('still does not blame them for the burst AFTER they have scrolled earlier in the visit', () => {
    // The reader scrolled up and came back to the bottom — a real gesture…
    const gesture = scrollEventIsTheReader({
      wrote: 5000,
      scrollTop: 3800,
      here: { id: 'evt#12', offset: -40 },
      was: here,
      placed: true,
    });
    expect(gesture).toBe(true);
    // …and the very next burst is judged on its own merits, not on that history.
    expect(
      scrollEventIsTheReader({
        wrote: 24_910,
        scrollTop: 24_910,
        here: { id: 'evt#900', offset: -10 },
        was: { id: 'evt#12', offset: -40 },
        placed: true,
      }),
    ).toBe(false);
  });

  // The gesture listeners never covered every device: keyboard paging,
  // scrollbar-thumb drags and drag-select autoscroll reach none of them
  // (measured: 7128px of real drag-select motion, 0 reader verdicts across 158
  // scroll events), and nor do sequential focus navigation onto an off-screen
  // button inside the log, or find-in-page. All of them move the reader's row.
  it('blames the reader for a device no gesture listener sees', () => {
    expect(
      scrollEventIsTheReader({
        wrote: 2000,
        scrollTop: 9128, // drag-select autoscroll
        here: { id: 'evt#300', offset: -8 },
        was: { id: 'evt#40', offset: -120 },
        placed: true,
      }),
    ).toBe(true);
  });

  // ── The causal gate ───────────────────────────────────────────────────────
  // iOS resumes a WKWebView by resetting overflow scroll, and the native scroll
  // event from that reset can arrive before any state update lands. Geometry
  // cannot tell it from a reader flicking to the top: clientHeight is back and
  // scrollTop is honestly 0. Believing it wrote the oldest on-screen row over
  // the reader's parked message, which the restore then reproduced faithfully.
  it('believes nothing until something has been placed', () => {
    expect(
      scrollEventIsTheReader({
        wrote: null,
        scrollTop: 0,
        here: { id: 'evt#1', offset: 0 },
        was: here,
        placed: false,
      }),
    ).toBe(false);
  });

  it('does not guess when there is nothing anchorable to compare', () => {
    expect(
      scrollEventIsTheReader({ wrote: 5000, scrollTop: 1, here: null, was: here, placed: true }),
    ).toBe(false);
  });
});

describe('recordFor — only a position the reader chose is ever stored', () => {
  const sid = { caughtUp: false, sid: 's1' };

  it('stores the message a parked reader is on', () => {
    const s = drive({ t: 'reader-moved', here: { id: 'evt#40', offset: -120 }, atEnd: false });
    expect(recordFor(s, sid)).toEqual({
      anchorId: 'evt#40',
      anchorOffset: -120,
      caughtUp: false,
      sid: 's1',
    });
  });

  it('stores a retirement for a reader at the end', () => {
    const s = drive({ t: 'jump-to-latest' });
    expect(recordFor(s, { caughtUp: true, sid: 's1' })).toEqual({
      anchorId: null,
      anchorOffset: 0,
      caughtUp: true,
      sid: 's1',
    });
  });

  // ── The hold flag this replaces ───────────────────────────────────────────
  // The old design wrote the memory from `onScroll`, which fires for every
  // writer's scrollTop as well as the reader's — so a restore's own intermediate
  // positions recorded themselves as reading positions, destroying the goal the
  // restore was chasing. It needed a flag (`holdRememberedAnchor`) to protect the
  // target from the loop hunting it, and the flag protected `anchorId` but not
  // `ratio`, which is exactly how the landing point came to walk further down on
  // every reopen. Here the store is written from the STATE, and the state only
  // holds a reading position when a reader input put one there.
  it('stores NOTHING while we do not know where the reader belongs', () => {
    expect(recordFor(drive({ t: 'shown', mem: parked() }), sid)).not.toBeNull();
    expect(recordFor(IDLE_STATE, sid)).toBeNull();
  });

  // A search jump is an explicit destination the user asked for from somewhere
  // else, not the place they were reading. Left ungated, the next ORDINARY open
  // of that chat — a click on the tab tomorrow, no search involved — would
  // restore a reader who had read to the end to a message from three weeks ago.
  it('stores NOTHING for a search hit, however deep it landed', () => {
    expect(recordFor(drive({ t: 'search-jump', id: 'evt#ancient' }), sid)).toBeNull();
  });

  it('…and starts recording again the moment the reader takes the pane back', () => {
    const s = drive(
      { t: 'search-jump', id: 'evt#ancient' },
      { t: 'search-cleared', here: { id: 'evt#70', offset: -12 }, atEnd: false },
    );
    expect(recordFor(s, sid)?.anchorId).toBe('evt#70');
  });

  it('records a parked reader who is nonetheless at the end as caught up', () => {
    const s = drive({ t: 'reader-moved', here: { id: 'evt#40', offset: -120 }, atEnd: false });
    expect(recordFor(s, { caughtUp: true, sid: 's1' })).toEqual({
      anchorId: null,
      anchorOffset: 0,
      caughtUp: true,
      sid: 's1',
    });
  });
});

describe('the transitions', () => {
  it('a visibility flip does not drag a live search hit back into history', () => {
    // Measured on the old design: parked at message 147, searched to 198,
    // backgrounded and returned — and was back at 147, a 14,696px jump
    // backwards, with the highlight gone too. A flip is not a gesture and does
    // not dismiss a highlight, so it must not re-assert the pre-search memory.
    const s = drive(
      { t: 'search-jump', id: 'evt#198' },
      { t: 'hidden' },
      { t: 'shown', mem: parked({ anchorId: 'evt#147' }) },
    );
    expect(s.intent).toEqual({ at: 'hit', id: 'evt#198' });
  });

  it('a visibility flip DOES re-read the memory for an ordinary reader', () => {
    const s = drive(
      { t: 'reader-moved', here: { id: 'evt#9', offset: 0 }, atEnd: false },
      { t: 'hidden' },
      { t: 'shown', mem: parked({ anchorId: 'evt#40' }) },
    );
    expect(s.intent).toEqual({ at: 'row', id: 'evt#40', offset: -120 });
  });

  it('being hidden keeps the intent — the reader has to be put back on return', () => {
    const s = drive({ t: 'shown', mem: parked() }, { t: 'hidden' });
    expect(s.intent).toEqual({ at: 'row', id: 'evt#40', offset: -120 });
    expect(s.placed).toBe(false);
  });

  it('jump-to-latest follows again, whatever came before it', () => {
    const s = drive(
      { t: 'shown', mem: parked() },
      { t: 'reader-moved', here: { id: 'evt#7', offset: -3 }, atEnd: false },
      { t: 'jump-to-latest' },
    );
    expect(s.intent).toEqual({ at: 'end' });
  });

  // Tapping a fold header is a height change the READER caused, in the middle
  // of the document. The old design could not tell it from a thumbnail
  // decoding, so for a reader at the bottom it answered an expand by scrolling
  // to the new bottom: measured, a 1500px expansion moved the tapped header from
  // +272 to -1228 while the reply below it did not move at all — i.e. tapping
  // "12 actions" visibly did nothing.
  it('a fold toggle holds the header the reader tapped', () => {
    const s = drive({ t: 'jump-to-latest' }, { t: 'fold-toggled', id: 'run#3', offset: 272 });
    expect(s.intent).toEqual({ at: 'row', id: 'run#3', offset: 272 });
  });

  it('the reader reaching the end starts following again', () => {
    const s = drive({ t: 'shown', mem: parked() }, { t: 'reader-moved', here: null, atEnd: true });
    expect(s.intent).toEqual({ at: 'end' });
  });

  it('a mount forgets everything', () => {
    const s = drive({ t: 'shown', mem: parked() }, { t: 'sought' }, { t: 'mounted' });
    expect(s).toEqual(IDLE_STATE);
  });

  // READING THE LAYOUT is what makes a scroll event believable — not moving
  // anybody. A pane whose intent is "we do not know where the reader belongs"
  // has still been looked at, and if the gate waits for a target the reader can
  // never be heard at all. That mistake cost three headline failures in a real
  // browser behind a green unit suite.
  it('measuring is what makes a scroll event believable', () => {
    const s = drive({ t: 'shown', mem: parked() });
    expect(s.placed).toBe(false);
    expect(next(s, { t: 'measured' }).placed).toBe(true);
  });

  it('…including when there is nothing to assert at all', () => {
    expect(next(IDLE_STATE, { t: 'measured' }).placed).toBe(true);
  });
});

// ── THE ORDER OF `mounted` AND `shown` IS LOAD-BEARING ──────────────────────
// This is the shape of a bug that cost three headline failures in a real
// browser. ChatPane had two layout effects — one dispatching `shown`, one
// dispatching `mounted` — and React runs them in DECLARATION order, so every
// fresh mount read the memory, set the intent from it, and then reset that
// intent to "we do not know". They are one effect now, with the reset first,
// because two effects is a place to get an order wrong silently.
describe('a reset after a restore throws the restore away', () => {
  it('mounted-then-shown restores the reader', () => {
    const s = drive({ t: 'mounted' }, { t: 'shown', mem: parked() });
    expect(s.intent).toEqual({ at: 'row', id: 'evt#40', offset: -120 });
  });

  it('shown-then-mounted does not — which is why they share an effect', () => {
    const s = drive({ t: 'shown', mem: parked() }, { t: 'mounted' });
    expect(s.intent).toEqual({ at: 'nothing' });
  });
});

// ── THE RUNAWAY PAGER ───────────────────────────────────────────────────────
// Acceptance failure 2, reproduced. A fresh mount rendered the WHOLE
// conversation — 990 rows, 211,298px, where the server serves a 128KB tail of
// 126 rows — so a reader who had touched nothing was 210,000px from the newest
// message. The loop: intent wrong -> phase IDLE -> the FOLLOWING guard does not
// fire -> nobody placed anyone so scrollTop is 0 -> page -> `events` changes ->
// the effect re-runs -> around again until the server runs out of history.
describe('shouldPageOlder', () => {
  const TAIL = { scrollTop: 0, scrollHeight: 28_098, clientHeight: 864 };
  const base = {
    placed: true,
    geo: TAIL,
    measurable: true,
    hasMoreOlder: true,
    loadingOlder: false,
    haveEvents: true,
    sessionBound: true,
  } as const;

  it('does not page for a reader who is following the tail', () => {
    expect(
      shouldPageOlder({
        ...base,
        phase: 'FOLLOWING',
        geo: { ...TAIL, scrollTop: 27_234 },
      }),
    ).toBe('no');
  });

  // …and the case that actually needs the FOLLOWING guard, which the assertion
  // above does not: a SHORT conversation, where the whole scrollable range is
  // narrower than the top zone. The reader is at the bottom watching live output
  // AND within 240px of the top, both at once — so without the guard the chat
  // pages history in behind them for as long as the server has any. A mutation
  // sweep found the first test passing with the guard deleted, because it put
  // the reader 27,234px from the top and the zone check carried it.
  it('…even when the tail is so short that the reader is inside the top zone', () => {
    const shortRange = { scrollTop: 136, scrollHeight: 1_000, clientHeight: 864 };
    expect(shouldPageOlder({ ...base, phase: 'FOLLOWING', geo: shortRange })).toBe('no');
    // The same geometry for a reader who is NOT following still pages.
    expect(shouldPageOlder({ ...base, phase: 'ANCHORED', geo: shortRange })).toBe('top-zone');
  });

  // The runaway, in one assertion. Before the fix this returned 'top-zone' on a
  // freshly mounted pane and did so again on every page it caused.
  it('does not page a pane whose layout nothing has read yet', () => {
    expect(shouldPageOlder({ ...base, phase: 'IDLE', placed: false })).toBe('no');
  });

  it('…and that holds however wrong the intent is', () => {
    for (const phase of ['FOLLOWING', 'ANCHORED', 'SEEKING', 'IDLE'] as const) {
      expect(shouldPageOlder({ ...base, phase, placed: false })).toBe('no');
    }
  });

  it('DOES page for a reader who has reached the top zone', () => {
    expect(shouldPageOlder({ ...base, phase: 'ANCHORED', geo: { ...TAIL, scrollTop: 120 } })).toBe(
      'top-zone',
    );
  });

  it('…and at exactly scrollTop 0, where no scroll event ever fires', () => {
    // A browser fires no scroll event when you wheel up at 0. Measured on the
    // old tree: 30 rows, scrollTop 0, hasMoreOlder true, 84 wheel notches, 0
    // requests. The effect re-runs on the events commit, which is what covers it.
    expect(shouldPageOlder({ ...base, phase: 'ANCHORED' })).toBe('top-zone');
  });

  it('does not page past the top zone', () => {
    expect(
      shouldPageOlder({ ...base, phase: 'ANCHORED', geo: { ...TAIL, scrollTop: 9_000 } }),
    ).toBe('no');
  });

  // The one case that pages without a reader asking, and the reason it must run
  // BEFORE the placed guard: with no overflow there are no scroll events at all,
  // so nothing will ever place anyone and the rest of the conversation is
  // unreachable forever.
  it('pages to fill a viewport the tail could not, even before anything is placed', () => {
    const short = { scrollTop: 0, scrollHeight: 400, clientHeight: 864 };
    expect(shouldPageOlder({ ...base, phase: 'IDLE', placed: false, geo: short })).toBe(
      'fill-viewport',
    );
  });

  it('stops when the server says there is no more', () => {
    expect(shouldPageOlder({ ...base, phase: 'ANCHORED', hasMoreOlder: false })).toBe('no');
    expect(
      shouldPageOlder({
        ...base,
        phase: 'IDLE',
        placed: false,
        hasMoreOlder: false,
        geo: { scrollTop: 0, scrollHeight: 400, clientHeight: 864 },
      }),
    ).toBe('no');
  });

  it('is single-flight — never asks while a request is in flight', () => {
    expect(shouldPageOlder({ ...base, phase: 'ANCHORED', loadingOlder: true })).toBe('no');
  });

  it('never pages a pane it cannot measure, or one with no session yet', () => {
    expect(shouldPageOlder({ ...base, phase: 'ANCHORED', measurable: false })).toBe('no');
    expect(shouldPageOlder({ ...base, phase: 'ANCHORED', sessionBound: false })).toBe('no');
  });
});
