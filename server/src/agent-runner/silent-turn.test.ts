import { describe, expect, it } from 'vitest';
import { isSilentTurn } from './silent-turn.js';

const turn = (over: Partial<Parameters<typeof isSilentTurn>[0]> = {}) =>
  isSilentTurn({ human: false, said: false, replies: 0, ...over });

describe('isSilentTurn', () => {
  it('is true for the case it was written for: an hourly card refresh', () => {
    // A cron fire whose own prompt says "Say nothing". Six of these a day in
    // one chat bolded the row six times for nothing.
    expect(turn()).toBe(true);
  });

  it('is false the moment the turn said ANYTHING', () => {
    expect(turn({ said: true })).toBe(false);
    expect(turn({ replies: 1 })).toBe(false);
  });

  it('is false for a turn a person typed, even a quiet one', () => {
    // They are waiting on it. "It finished" is news on its own, and a silent
    // answer to a direct question is exactly the thing you go and look at.
    expect(turn({ human: true })).toBe(false);
    expect(turn({ human: true, said: false, replies: 0 })).toBe(false);
  });

  it('is false for a failure — an error is always news', () => {
    expect(turn({ failed: true })).toBe(false);
  });

  it('answers false whenever two signals disagree', () => {
    // The failure directions are not symmetric: an extra bold row is noise a
    // glance clears, a missing one loses news with nothing to notice.
    expect(turn({ human: true, said: true, replies: 2, failed: true })).toBe(false);
  });
});
