import { describe, expect, it } from 'vitest';
import { DeliveryQueue, IDLE_QUIET_MS, conversationMovedOn, reanchorInstruction } from './delivery';
import type { AppendIntent } from './protocol';

const say = (text: string): AppendIntent => ({ kind: 'commentary', text });

function queue() {
  const q = new DeliveryQueue<string>();
  const push = (id: string, at = 0) =>
    q.push({ item: id, intent: say(id), policy: 'when_idle', queuedAt: at });
  return { q, push };
}

describe('holding the floor', () => {
  it('releases nothing while the user is still speaking', () => {
    const { q, push } = queue();
    push('answer');
    expect(q.release(1000, 900, IDLE_QUIET_MS)).toEqual([]);
    expect(q.size).toBe(1);
  });

  it('releases once they have stopped', () => {
    const { q, push } = queue();
    push('answer');
    const out = q.release(2000, 900, IDLE_QUIET_MS);
    expect(out.map((h) => h.item)).toEqual(['answer']);
    expect(q.size).toBe(0);
  });

  it('REQUEUES rather than dropping — a refused answer is not a lost one', () => {
    const { q, push } = queue();
    push('answer');
    expect(q.release(1000, 900, IDLE_QUIET_MS)).toEqual([]);
    expect(q.release(3000, 900, IDLE_QUIET_MS).map((h) => h.item)).toEqual(['answer']);
  });

  it('preserves order — narration out of sequence is worse than late', () => {
    const { q, push } = queue();
    push('first');
    push('second');
    push('third');
    expect(q.release(5000, 0, IDLE_QUIET_MS).map((h) => h.item)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('holds the whole queue, not just the head', () => {
    const { q, push } = queue();
    push('first');
    push('second');
    expect(q.release(1000, 900, IDLE_QUIET_MS)).toEqual([]);
    expect(q.size).toBe(2);
  });

  it('drops everything on a cancel — held narration for work that no longer exists', () => {
    const { q, push } = queue();
    push('answer');
    q.clear();
    expect(q.release(5000, 0, IDLE_QUIET_MS)).toEqual([]);
  });
});

describe('has the conversation moved on?', () => {
  const base = {
    dispatchedAt: 1000,
    intermediatesSent: 0,
    lastInputDeltaAt: 500,
    lastOutputAt: 500,
  };

  it('no, when nothing has happened since the request went out', () => {
    expect(conversationMovedOn(base)).toBe(false);
  });

  it('yes, when the user has said something since', () => {
    expect(conversationMovedOn({ ...base, lastInputDeltaAt: 2000 })).toBe(true);
  });

  it('yes, when the model has said something since', () => {
    expect(conversationMovedOn({ ...base, lastOutputAt: 2000 })).toBe(true);
  });

  it('yes, when we have already given a progress update', () => {
    expect(conversationMovedOn({ ...base, intermediatesSent: 1 })).toBe(true);
  });

  it('copes with a session where the model has never spoken', () => {
    expect(conversationMovedOn({ ...base, lastOutputAt: Number.NEGATIVE_INFINITY })).toBe(false);
  });
});

describe('re-anchoring a late result', () => {
  it('tells the model to finish its current thought first', () => {
    const line = reanchorInstruction('run the whole test suite');
    expect(line).toMatch(/finish responding to whatever the user is talking about now/i);
    expect(line).toContain('run the whole test suite');
  });

  it('truncates a long request rather than blowing the append budget', () => {
    const line = reanchorInstruction('x'.repeat(500));
    expect(line.length).toBeLessThan(450);
    expect(line).toContain('…');
  });
});
