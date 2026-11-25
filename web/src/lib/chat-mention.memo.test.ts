import type { Tab } from '@muxpad/shared';
import { describe, expect, it, vi } from 'vitest';
import { toMentionChats } from './chat-mention';
import type { WorkspaceTabs } from './nav-search';

const tab = (name: string) => ({ id: 't', slug: 't', name, layout: 'p' }) as Tab;
const corpus = (row: Tab): WorkspaceTabs[] => [{ id: 'w', slug: 'w', name: 'Work', tabs: [row] }];

describe('mention corpus shared by mounted transcripts', () => {
  it('converts the same published corpus only once across readers', () => {
    const row = tab('Before');
    const name = vi.fn(() => 'Before');
    Object.defineProperty(row, 'name', { enumerable: true, get: name });
    const groups = corpus(row);
    const first = toMentionChats(groups);
    name.mockClear();
    for (let i = 0; i < 40; i++) expect(toMentionChats(groups)).toBe(first);
    expect(name).not.toHaveBeenCalled();
    expect(first[0]?.tabName).toBe('Before');
  });

  it('updates chips and reports on the next immutable publish and can still serve a held snapshot', () => {
    const groups = corpus(tab('Before'));
    const before = toMentionChats(groups);
    const updated = corpus({
      ...tab('After'),
      spawn_report: 'done',
      spawn_report_state: 'ok',
      spawn_report_at: 42,
    });
    const after = toMentionChats(updated);
    expect(after).not.toBe(before);
    expect(after[0]).toMatchObject({
      tabName: 'After',
      chip: { name: 'After' },
      report: { text: 'done', at: 42 },
    });
    expect(toMentionChats(updated)).toBe(after);
    expect(toMentionChats(groups)).toBe(before);
  });
});
