import { describe, expect, it } from 'vitest';
import { type LogEntry, type SpawnCard, collapseSpawnPairs } from './chat-mention';

/**
 * TWO CARDS ARE A HISTORY. TWO CARDS WITH NOTHING BETWEEN THEM ARE A
 * REPETITION.
 *
 * The pair exists because a long job's result has to arrive where the reader is
 * LOOKING — a new entry at the bottom — while the launch stays where it
 * happened. That argument evaporates when the completion lands directly on its
 * own launch, which is the common case for a fast worker and the one that
 * produced "one sub chat yielded three messages".
 */
const card = (
  tabId: string,
  kind: 'launch' | 'completion',
  at: number,
  roundId?: string,
): LogEntry<string> => ({
  kind: 'card',
  card: {
    chat: { tabId, name: tabId } as unknown as SpawnCard['chat'],
    kind,
    at,
    anchorId: `${kind}-${tabId}-${roundId ?? 'x'}`,
    ...(roundId ? { round: { id: roundId } as unknown as SpawnCard['round'] } : {}),
  } as SpawnCard,
});
const msg = (node: string): LogEntry<string> => ({ kind: 'entry', node });
const shape = (l: readonly LogEntry<string>[]) =>
  l.map((x) => (x.kind === 'entry' ? x.node : `${x.card.kind}:${x.card.chat.tabId}`));

describe('a pair with nothing between it is one card', () => {
  it('absorbs the launch and remembers when it happened', () => {
    const out = collapseSpawnPairs([card('t1', 'launch', 100), card('t1', 'completion', 1100)]);
    expect(shape(out)).toEqual(['completion:t1']);
    expect(out[0]?.kind === 'card' && out[0].openedAt).toBe(100);
  });

  it('keeps BOTH when anything at all happened in between', () => {
    // Then the launch is genuinely the record of a moment the log has moved
    // past, and the result still has to arrive where the reader is looking.
    const out = collapseSpawnPairs([
      card('t1', 'launch', 100),
      msg('the user said something'),
      card('t1', 'completion', 1100),
    ]);
    expect(shape(out)).toEqual(['launch:t1', 'the user said something', 'completion:t1']);
  });

  it("never absorbs ANOTHER CHILD's launch", () => {
    // Two workers started back to back is the shape of every fan-out.
    const out = collapseSpawnPairs([card('t1', 'launch', 100), card('t2', 'completion', 1100)]);
    expect(shape(out)).toEqual(['launch:t1', 'completion:t2']);
  });

  it('never absorbs a DIFFERENT ROUND of the same child', () => {
    // A worker is a sequence of jobs; job three's completion swallowing job
    // one's launch would delete a launch that happened.
    const out = collapseSpawnPairs([
      card('t1', 'launch', 100, 'r1'),
      card('t1', 'completion', 1100, 'r3'),
    ]);
    expect(shape(out)).toEqual(['launch:t1', 'completion:t1']);
  });

  it('collapses each pair of a fan-out independently', () => {
    const out = collapseSpawnPairs([
      card('a', 'launch', 10, 'r'),
      card('a', 'completion', 20, 'r'),
      card('b', 'launch', 30, 'r'),
      card('b', 'completion', 40, 'r'),
    ]);
    expect(shape(out)).toEqual(['completion:a', 'completion:b']);
  });

  it('leaves a lone launch alone — the worker is still running', () => {
    expect(shape(collapseSpawnPairs([card('t1', 'launch', 100)]))).toEqual(['launch:t1']);
  });

  it('returns the SAME array when nothing collapsed — no needless rerender', () => {
    const input = [msg('hello'), card('t1', 'launch', 100)];
    expect(collapseSpawnPairs(input)).toBe(input);
  });
});
