import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryTerms } from './search-highlight';
import {
  type JumpCandidate,
  SEARCH_JUMP_EVENT,
  type SearchJump,
  clearSearchJumps,
  jumpMayBeOlder,
  pickSearchTarget,
  requestSearchJump,
  takeSearchJump,
} from './search-jump';

function ev(id: string, ts: number | null, text?: string): JumpCandidate {
  return text === undefined ? { id, ts } : { id, ts, text };
}

const jump = (over: Partial<SearchJump> = {}): SearchJump => ({
  paneId: 'p1',
  query: 'bug',
  sid: 's1',
  ts: 1000,
  ...over,
});

describe('the pending-jump mailbox', () => {
  beforeEach(clearSearchJumps);

  it('hands the jump to the pane it names, once', () => {
    requestSearchJump(jump());
    expect(takeSearchJump('p1')).toMatchObject({ query: 'bug', sid: 's1', ts: 1000 });
    // CONSUMING: a remount (a re-render, a reconnect) must not replay the jump
    // and drag a reader who has moved on back into history.
    expect(takeSearchJump('p1')).toBeNull();
  });

  it('does not answer for a different pane', () => {
    requestSearchJump(jump());
    expect(takeSearchJump('p2')).toBeNull();
  });

  it('supersedes an unclaimed jump to the same pane', () => {
    requestSearchJump(jump({ query: 'first' }));
    requestSearchJump(jump({ query: 'second' }));
    expect(takeSearchJump('p1')?.query).toBe('second');
  });

  it('also broadcasts, for a ChatPane that is already mounted', () => {
    const seen: SearchJump[] = [];
    const onJump = (e: Event) => seen.push((e as CustomEvent<SearchJump>).detail);
    window.addEventListener(SEARCH_JUMP_EVENT, onJump);
    requestSearchJump(jump());
    window.removeEventListener(SEARCH_JUMP_EVENT, onJump);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.paneId).toBe('p1');
  });

  it('is not persisted anywhere — a reload must not come back highlighted', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    requestSearchJump(jump());
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

describe('pickSearchTarget — which message the hit actually names', () => {
  const terms = queryTerms('scroll bug');

  it('only ever picks a message that CONTAINS a term', () => {
    // The honesty guarantee. If nothing loaded says it, we say nothing —
    // the caller pages history in rather than lighting up the nearest row.
    const events = [ev('a', 1000, 'hello'), ev('b', 1001, 'goodbye')];
    expect(pickSearchTarget(events, { terms, ts: 1000 })).toBeNull();
  });

  it('prefers the message with MORE of the terms — FTS5 conjoins them', () => {
    const events = [
      ev('mentions-one', 1000, 'just a bug'),
      ev('mentions-both', 5000, 'a scroll bug'),
    ];
    expect(pickSearchTarget(events, { terms, ts: 1000 })).toBe('mentions-both');
  });

  it('uses the hit timestamp to pick between equally-good matches', () => {
    // This is what stops "the first match on screen" from being the answer in
    // a conversation that uses the word constantly.
    const events = [
      ev('old', 1000, 'a scroll bug'),
      ev('the-one', 5000, 'a scroll bug'),
      ev('new', 9000, 'a scroll bug'),
    ];
    expect(pickSearchTarget(events, { terms, ts: 5100 })).toBe('the-one');
  });

  it('falls back to the NEWEST match when the hit carried no timestamp', () => {
    const events = [ev('old', 1000, 'a scroll bug'), ev('new', 9000, 'a scroll bug')];
    expect(pickSearchTarget(events, { terms, ts: null })).toBe('new');
  });

  it('prefers a candidate WITH a timestamp over one without', () => {
    const events = [ev('undated', null, 'a scroll bug'), ev('dated', 5000, 'a scroll bug')];
    expect(pickSearchTarget(events, { terms, ts: 5000 })).toBe('dated');
  });

  it('ignores events with no text at all (tool calls)', () => {
    const events = [ev('tool', 1000), ev('msg', 4000, 'the scroll bug')];
    expect(pickSearchTarget(events, { terms, ts: 1000 })).toBe('msg');
  });

  it('returns null with no terms, rather than picking arbitrarily', () => {
    expect(pickSearchTarget([ev('a', 1, 'anything')], { terms: [], ts: 1 })).toBeNull();
  });

  it('finds a Hebrew message by a Hebrew term', () => {
    const events = [ev('en', 1000, 'english only'), ev('he', 2000, 'יש כאן באג בגלילה')];
    expect(pickSearchTarget(events, { terms: queryTerms('באג'), ts: 2000 })).toBe('he');
  });
});

describe('jumpMayBeOlder — is paging backwards worth it?', () => {
  const loaded = [ev('a', 5000, 'x'), ev('b', 9000, 'y')];

  it('yes when the hit predates everything loaded — the window is a TAIL', () => {
    expect(jumpMayBeOlder(loaded, 1000)).toBe(true);
  });

  it('no when the hit is already inside the loaded range and still not found', () => {
    // Paging cannot produce it; the honest answer is to say so. (A subagent
    // sidechain is the real-world case: the archive indexes it, the chat view
    // does not render it.)
    expect(jumpMayBeOlder(loaded, 7000)).toBe(false);
  });

  it('yes with no timestamp to go on — the page budget bounds being wrong', () => {
    expect(jumpMayBeOlder(loaded, null)).toBe(true);
  });

  it('yes when nothing loaded has a timestamp either', () => {
    expect(jumpMayBeOlder([ev('a', null, 'x')], 1000)).toBe(true);
    expect(jumpMayBeOlder([], 1000)).toBe(true);
  });
});
