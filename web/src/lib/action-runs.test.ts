import type { ChatAction } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { actionRuns, runSummary } from './action-runs';

const act = (kind: string, over: Partial<ChatAction> = {}): ChatAction =>
  ({
    id: `${kind}-${Math.random()}`,
    kind,
    title: kind,
    state: 'sent',
    at: 1,
    ...over,
  }) as ChatAction;

describe('consecutive reads fold into one row', () => {
  it('folds a run of reads', () => {
    const runs = actionRuns([
      act('msgvault.search'),
      act('msgvault.search'),
      act('msgvault.show-message'),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.folded).toBe(true);
    expect(runSummary(runs[0]!)).toBe('3 reads · your mail');
  });

  it('a single read is not a run — a fold there costs a click and saves nothing', () => {
    const runs = actionRuns([act('msgvault.stats')]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.folded).toBe(false);
  });

  it('a WRITE never folds, and breaks the run around it', () => {
    // The card exists because an outbound effect needs a durable record.
    // Burying it would delete the only reason it was built.
    const runs = actionRuns([
      act('msgvault.search'),
      act('msgvault.search'),
      act('slack.post'),
      act('msgvault.search'),
      act('msgvault.search'),
    ]);
    expect(runs.map((r) => [r.actions.length, r.folded])).toEqual([
      [2, true],
      [1, false],
      [2, true],
    ]);
    expect(runs[1]?.actions[0]?.kind).toBe('slack.post');
  });

  it('anything still waiting on a person stays out of the fold', () => {
    // A pending approval is the one card here you might need to act on, and a
    // fold is where a reader stops looking.
    const runs = actionRuns([
      act('msgvault.search'),
      act('msgvault.search'),
      act('msgvault.search', { state: 'pending' }),
      act('msgvault.search'),
      act('msgvault.search'),
    ]);
    expect(runs.map((r) => [r.actions.length, r.folded])).toEqual([
      [2, true],
      [1, false],
      [2, true],
    ]);
    expect(runs[1]?.actions[0]?.state).toBe('pending');
    expect(runs.flatMap((r) => (r.folded ? r.actions : []))).toSatisfy((kept: unknown) =>
      (kept as ChatAction[]).every((a) => a.state !== 'pending'),
    );
  });

  it('names both systems when a run spans them, rather than picking one', () => {
    const runs = actionRuns([act('msgvault.search'), act('slack.search')]);
    expect(runSummary(runs[0]!)).toBe('2 reads · your mail · Slack');
  });

  it('never says "archive" — that is muxpad\'s word, not the data\'s', () => {
    const runs = actionRuns([act('msgvault.search'), act('msgvault.stats')]);
    expect(runSummary(runs[0]!)).not.toMatch(/archive/i);
    expect(runSummary(runs[0]!)).toContain('your mail');
  });

  it('a failed read still folds — it is a read that did not happen, not an effect', () => {
    const runs = actionRuns([act('msgvault.search', { state: 'failed' }), act('msgvault.search')]);
    expect(runs[0]?.folded).toBe(true);
  });
});
