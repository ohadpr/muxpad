import { describe, expect, it } from 'vitest';
import { liveStatusLabel } from './live-status';

describe('liveStatusLabel', () => {
  it('hides when nothing is running at all', () => {
    expect(liveStatusLabel({ chats: 0, turnActive: false })).toBeNull();
  });

  // The reported bug. The bar showed something running ONLY when subagents
  // happened to exist, so an ordinary turn — the common case — left it looking
  // idle while the sidebar row for the same pane said `working`.
  it('says Working for a turn with nothing rostered', () => {
    expect(liveStatusLabel({ chats: 0, turnActive: true })).toBe('Working…');
  });

  it('prefers a count when there is one — it is more informative', () => {
    expect(liveStatusLabel({ chats: 2, turnActive: true })).toBe('2 agents');
  });

  it('singularizes one agent', () => {
    expect(liveStatusLabel({ chats: 1, turnActive: true })).toBe('1 agent');
  });

  // A subagent can outlive the turn that launched it, which is why the roster
  // is checked first and independently of `turnActive`.
  it('still reports work running after the turn that launched it ended', () => {
    expect(liveStatusLabel({ chats: 3, turnActive: false })).toBe('3 agents');
  });

  it('treats a missing turnActive as not running, so old callers are unchanged', () => {
    expect(liveStatusLabel({ chats: 0 })).toBeNull();
    expect(liveStatusLabel({ chats: 2 })).toBe('2 agents');
  });
});

/**
 * TWO POPULATIONS, NEVER ONE NUMBER.
 *
 * Observed: the cell read `5 agents` while the sidebar showed 2 rows. The
 * sidebar was right — three of the five workers had finished — and the question
 * that came back was "do the 5 agents count some additional primitive that
 * doesn't show up in the sidebar?". These hold the answer to that question at
 * "it cannot".
 */
describe('the number never mixes child chats with harness subagents', () => {
  it('counts ONLY the chats in the leading number', () => {
    // The chats are the ones with sidebar rows, so the number a reader checks
    // against the sidebar has to be the one they read first.
    expect(liveStatusLabel({ chats: 2, subagents: 3 })).toMatch(/^2 agents/);
  });

  it('names the subagents rather than folding them into the count', () => {
    // The exact shape of the observed failure: 2 running children, 3 harness
    // subagents. It used to render `5 agents`, which is neither population.
    expect(liveStatusLabel({ chats: 2, subagents: 3 })).toBe('2 agents · 3 subagents');
    expect(liveStatusLabel({ chats: 5, subagents: 0 })).toBe('5 agents');
    expect(liveStatusLabel({ chats: 0, subagents: 5 })).toBe('5 subagents');
  });

  it('never renders a bare count that is the sum of both', () => {
    // The specific string the bug produced, pinned so it cannot come back under
    // any combination that adds to it.
    for (const [chats, subagents] of [
      [5, 0],
      [4, 1],
      [3, 2],
      [2, 3],
      [1, 4],
      [0, 5],
    ] as const) {
      const label = liveStatusLabel({ chats, subagents });
      if (chats > 0 && subagents > 0) expect(label).not.toBe('5 agents');
    }
  });

  it('singularizes each population on its own', () => {
    expect(liveStatusLabel({ chats: 1, subagents: 1 })).toBe('1 agent · 1 subagent');
  });

  it('says Working for a turn with neither, not an empty join', () => {
    expect(liveStatusLabel({ chats: 0, subagents: 0, turnActive: true })).toBe('Working…');
    expect(liveStatusLabel({ chats: 0, subagents: 0, turnActive: false })).toBeNull();
  });

  it('reports subagents that outlived their turn, with no chats at all', () => {
    // `turnActive` false and no children: the roster is still the reason the
    // cell is visible, and calling them "agents" is what made it ambiguous.
    expect(liveStatusLabel({ chats: 0, subagents: 2, turnActive: false })).toBe('2 subagents');
  });
});
