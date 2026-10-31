import { describe, expect, it } from 'vitest';
import { isSilentTurn, proseSpeaks } from './silent-turn.js';

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

describe('proseSpeaks', () => {
  it('counts prose in agent mode, which is the normal case', () => {
    expect(proseSpeaks({ mode: 'agent', cron: false })).toBe(true);
  });

  it('does not count it in chat mode — there prose is the scratchpad', () => {
    expect(proseSpeaks({ mode: 'chat', cron: false })).toBe(false);
  });

  it('does not count it on a CRON FIRE, in either mode', () => {
    // The chat never promotes a fire's prose (MACHINE_TURN_VARIANTS), so
    // nothing downstream may treat it as news. `nw-hourly` is a card
    // refresher whose prompt says "Say nothing" three different ways and
    // signs off "Card updated." anyway — the log showed nothing and the push
    // buzzed a phone every weekday hour. Asking a model to be silent is not a
    // mechanism.
    expect(proseSpeaks({ mode: 'agent', cron: true })).toBe(false);
    expect(proseSpeaks({ mode: 'chat', cron: true })).toBe(false);
  });

  it('leaves the deliberate channels alone', () => {
    // Not this function's job and that is the point: `muxpad say`, a `reply`
    // and a failure set `said`/`replies`/`failed` directly, so a cron with
    // real news still reaches the chat and the phone.
    expect(isSilentTurn({ human: false, said: true, replies: 0 })).toBe(false);
    expect(isSilentTurn({ human: false, said: false, replies: 1 })).toBe(false);
    expect(isSilentTurn({ human: false, said: false, replies: 0, failed: true })).toBe(false);
    expect(isSilentTurn({ human: false, said: false, replies: 0 })).toBe(true);
  });
});
