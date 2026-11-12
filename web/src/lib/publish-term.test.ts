import { describe, expect, it } from 'vitest';
import { publishTerm } from './publish-term';

/**
 * A muxpad link answers for seven days and then 410s. That fact lived in
 * `muxpad publish --list` and nowhere a person would look, so an artifact
 * someone was still sharing went dark with no warning. The row says it now.
 */
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe('how long a link has left', () => {
  it('says nothing for a link that never expires', () => {
    // Everything published before links had a shelf life, plus `--days=0`.
    // A "live" badge on every one of those is noise on the majority.
    expect(publishTerm({ expires: null, expired: false }, NOW)).toBeNull();
  });

  it('counts the days while there is no hurry', () => {
    expect(publishTerm({ expires: NOW + 6 * DAY, expired: false }, NOW)).toEqual({
      label: '6d',
      state: 'live',
    });
  });

  it('warns inside two days, which is when keeping it is worth doing NOW', () => {
    expect(publishTerm({ expires: NOW + 2 * DAY - 1, expired: false }, NOW)?.state).toBe('soon');
    expect(publishTerm({ expires: NOW + 30 * 60 * 1000, expired: false }, NOW)).toEqual({
      label: 'today',
      state: 'soon',
    });
  });

  it('says expired rather than hiding the row', () => {
    // The bytes are still there and Revive brings the link back, so a dead
    // link is a row with an action, not an absence.
    expect(publishTerm({ expires: NOW - DAY, expired: true }, NOW)).toEqual({
      label: 'expired',
      state: 'expired',
    });
    // …and trusts the clock as well as the flag, for a listing fetched a
    // while ago and still on screen.
    expect(publishTerm({ expires: NOW - 1, expired: false }, NOW)?.label).toBe('expired');
  });

  it('is null when the artifact is not in the published listing at all', () => {
    // The listing can fail to load; the links must still render.
    expect(publishTerm(undefined, NOW)).toBeNull();
  });
});
