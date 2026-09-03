import { describe, expect, it } from 'vitest';
import { describeChanges, summarizeChanges } from './dictation-cleanup';

describe('describeChanges', () => {
  it('finds a single-word substitution', () => {
    expect(describeChanges('check the crown schedule', 'check the cron schedule')).toEqual([
      { from: 'crown', to: 'cron' },
    ]);
  });

  it('collapses a multi-word mishearing into one pair', () => {
    // "Max pad" → "muxpad" is two words becoming one; reporting it as two
    // separate edits would be unreadable.
    expect(describeChanges('deploy Max pad tonight', 'deploy muxpad tonight')).toEqual([
      { from: 'Max pad', to: 'muxpad' },
    ]);
    expect(describeChanges('the academy go to market deck', 'the Acme GTM deck')).toEqual([
      { from: 'academy go to market', to: 'Acme GTM' },
    ]);
  });

  it('finds several substitutions in one message', () => {
    const changes = describeChanges(
      'check the crown schedule on Max pad for nimble',
      'check the cron schedule on muxpad for nimbus',
    );
    expect(changes).toEqual([
      { from: 'crown', to: 'cron' },
      { from: 'Max pad', to: 'muxpad' },
      { from: 'nimble', to: 'nimbus' },
    ]);
  });

  it('reports nothing when nothing moved', () => {
    const same = 'this text was transcribed correctly';
    expect(describeChanges(same, same)).toEqual([]);
  });

  it('is unfazed by newlines and multiple spaces', () => {
    expect(describeChanges('line one\n\ncrown  schedule', 'line one\n\ncron schedule')).toEqual([
      { from: 'crown', to: 'cron' },
    ]);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(describeChanges('run the job', 'run the cron job')).toEqual([{ from: '', to: 'cron' }]);
    expect(describeChanges('run the cron job', 'run the job')).toEqual([{ from: 'cron', to: '' }]);
  });

  it('handles an empty side', () => {
    expect(describeChanges('', 'muxpad')).toEqual([{ from: '', to: 'muxpad' }]);
    expect(describeChanges('muxpad', '')).toEqual([{ from: 'muxpad', to: '' }]);
    expect(describeChanges('', '')).toEqual([]);
  });

  it('reports every substitution — trimming for display is the summary’s job', () => {
    const before = 'aa and bb and cc and dd and ee';
    const after = 'a1 and b1 and c1 and d1 and e1';
    expect(describeChanges(before, after)).toHaveLength(5);
  });
});

describe('summarizeChanges', () => {
  it('renders the pairs with an arrow', () => {
    expect(
      summarizeChanges([
        { from: 'crown', to: 'cron' },
        { from: 'Max pad', to: 'muxpad' },
      ]),
    ).toBe('crown → cron · Max pad → muxpad');
  });

  it('says so when nothing changed', () => {
    expect(summarizeChanges([])).toBe('No changes');
  });

  it('falls back to a count when only insertions/deletions are in play', () => {
    expect(summarizeChanges([{ from: '', to: 'cron' }])).toBe('1 change');
    expect(
      summarizeChanges([
        { from: 'cron', to: '' },
        { from: '', to: 'job' },
      ]),
    ).toBe('2 changes');
  });

  it('says how many it left out rather than silently showing the first few', () => {
    // The affordance's promise is "eyeball what changed" — four of nine
    // corrections rendered as if they were all of them breaks that.
    const nine = Array.from({ length: 9 }, (_, i) => ({ from: `a${i}`, to: `b${i}` }));
    const line = summarizeChanges(nine);
    expect(line).toContain('a0 → b0');
    expect(line).toContain('+5 more');
    expect(summarizeChanges(nine.slice(0, 4))).not.toContain('more');
  });
});
