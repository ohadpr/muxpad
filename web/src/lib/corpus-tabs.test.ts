import type { Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { corpusTabs } from './corpus-tabs';

const tab = (id: string, fields: Partial<Tab> = {}) => ({ id, ...fields }) as Tab;

describe('structural corpus projection', () => {
  it('uses authoritative membership, including retired chats owning work', () => {
    const rows = [
      tab('historical', { done: true, corpus_live: false }),
      tab('retired-owner', { done: true, corpus_live: true, status: 'idle' }),
      tab('live', { corpus_live: true }),
      tab('excluded-even-if-working', { corpus_live: false, status: 'working' }),
    ];
    expect(corpusTabs(rows).map((t) => t.id)).toEqual(['retired-owner', 'live']);
    expect(corpusTabs(rows)[0]).toBe(rows[1]);
  });

  it('keeps the fallback stable for repeated reads but updates on a new list', () => {
    const rows = [tab('old', { corpus_live: false }), tab('live', { corpus_live: true })];
    const first = corpusTabs(rows);
    expect(corpusTabs(rows)).toBe(first);
    const updated = corpusTabs([rows[0]!, tab('new', { corpus_live: true })]);
    expect(updated).not.toBe(first);
    expect(updated.map((t) => t.id)).toEqual(['new']);
  });

  it('preserves legacy rows when the server has no membership marker', () => {
    expect(corpusTabs([tab('legacy', { done: true })]).map((t) => t.id)).toEqual(['legacy']);
  });
});
