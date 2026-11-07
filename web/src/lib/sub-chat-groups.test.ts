import { describe, expect, it } from 'vitest';
import { type SubChat, subChatGroups } from './sub-chats';

const sub = (name: string, o: { done?: boolean; at?: number } = {}): SubChat =>
  ({
    chat: {
      tabId: name,
      tabName: name,
      tabSlug: name,
      paneIds: [`${name}-p`],
      done: o.done ?? false,
      createdAt: o.at ?? 0,
    },
    paneId: `${name}-p`,
  }) as unknown as SubChat;

/** The drawer shows `tabName`; the tests name rows by it. */
const names = (subs: readonly SubChat[]) => subs.map((s) => s.chat.tabName);

/** 2026-11-06 14:00 local, and the day before it. */
const NOW = new Date(2026, 10, 6, 14, 0, 0).getTime();
const at = (h: number) => NOW - h * 3600_000;

describe('the drawer’s blocks', () => {
  it('puts running first, whatever it was spawned at', () => {
    const g = subChatGroups(
      [sub('old-done', { done: true, at: at(1) }), sub('going', { at: at(50) })],
      NOW,
    );
    expect(g.map((x) => x.key)).toEqual(['running', 'today']);
    expect(names(g[0]?.subs ?? [])).toEqual(['going']);
  });

  it('splits the finished ones by calendar day, not by elapsed hours', () => {
    // A worker that reported at 23:50 is not "yesterday" ten minutes later.
    const lateLastNight = new Date(2026, 10, 5, 23, 50).getTime();
    const g = subChatGroups(
      [
        sub('this-morning', { done: true, at: at(6) }),
        sub('last-night', { done: true, at: lateLastNight }),
        sub('ages-ago', { done: true, at: at(96) }),
      ],
      NOW,
    );
    expect(g.map((x) => x.key)).toEqual(['today', 'yesterday', 'earlier']);
  });

  it('cools by one step per block, so the list fades as it ages', () => {
    // The accent is the second rendering of the one fact this panel is about.
    const g = subChatGroups(
      [
        sub('going'),
        sub('a', { done: true, at: at(2) }),
        sub('b', { done: true, at: at(26) }),
        sub('c', { done: true, at: at(100) }),
      ],
      NOW,
    );
    expect(g.map((x) => x.heat)).toEqual([3, 2, 1, 0]);
  });

  it('drops empty blocks rather than drawing them', () => {
    expect(subChatGroups([sub('going')], NOW).map((g) => g.key)).toEqual(['running']);
    expect(subChatGroups([], NOW)).toEqual([]);
  });

  it('labels a single block too', () => {
    // The first attempt hid the heading when only one block existed, which
    // made it look like the old flat list and taught the reader nothing.
    const g = subChatGroups([sub('a', { done: true, at: at(1) })], NOW);
    expect(g[0]?.label).toBe('Today');
  });

  it('sorts finished newest-first and leaves running in spawn order', () => {
    const g = subChatGroups(
      [
        sub('r1', { at: at(9) }),
        sub('r2', { at: at(8) }),
        sub('older', { done: true, at: at(5) }),
        sub('newer', { done: true, at: at(1) }),
      ],
      NOW,
    );
    expect(names(g[0]?.subs ?? [])).toEqual(['r1', 'r2']);
    expect(names(g[1]?.subs ?? [])).toEqual(['newer', 'older']);
  });

  it('treats a worker with no timestamp as earlier, not as today', () => {
    // Absent is not recent. A row with no stamp sorting to the top of Today
    // would be the one thing in the list claiming to be news.
    const g = subChatGroups([sub('stampless', { done: true, at: 0 })], NOW);
    expect(g[0]?.key).toBe('earlier');
  });
});
