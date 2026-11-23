import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LIMIT,
  activityChats,
  isUnreadChat,
  sectionsOf,
  shortAgo,
  unreadChats,
} from './chat-sections';
import type { SearchableTab } from './nav-search';

const NOW = Date.UTC(2026, 10, 23, 15, 0, 0);
const chat = (id: string, extra: Partial<SearchableTab> = {}): SearchableTab => ({
  tabId: id,
  tabSlug: id,
  tabName: id,
  workspaceId: 'w',
  workspaceSlug: 'w',
  workspaceName: 'W',
  paneIds: [],
  lastUserAt: NOW - 1000,
  lastActivityAt: NOW - 1000,
  ...extra,
});

describe('which chats are Unread', () => {
  it('is the wire’s `unread` — a pane an agent finished in, or a hand mark', () => {
    expect(isUnreadChat(chat('a', { unread: true }))).toBe(true);
    expect(isUnreadChat(chat('a', { unread: false }))).toBe(false);
    expect(isUnreadChat(chat('a'))).toBe(false);
  });

  it('leaves sub-chats out — their news is already their parent’s unread', () => {
    expect(isUnreadChat(chat('w', { unread: true, spawnedBy: 'parent' }))).toBe(false);
  });

  it('keeps a done chat that is unread: unread is exactly what you have not touched', () => {
    expect(isUnreadChat(chat('old', { unread: true, done: true }))).toBe(true);
  });

  it('lists them most recently active first, stably', () => {
    const rows = unreadChats([
      chat('old', { unread: true, lastActivityAt: NOW - 9000 }),
      chat('read'),
      chat('new', { unread: true, lastActivityAt: NOW - 10 }),
      chat('tie-b', { unread: true, lastActivityAt: NOW - 500 }),
      chat('tie-a', { unread: true, lastActivityAt: NOW - 500 }),
    ]);
    expect(rows.map((r) => r.tabId)).toEqual(['new', 'tie-a', 'tie-b', 'old']);
  });

  it('is empty when everything is read — the good case', () => {
    expect(unreadChats([chat('a'), chat('b')])).toEqual([]);
  });
});

describe('which chats are in Activity', () => {
  it('is the ⌘K recents ranking: by when YOU touched it, no workers, nothing done', () => {
    const rows = activityChats([
      chat('worker', { spawnedBy: 'p', lastUserAt: NOW }),
      chat('done', { done: true, lastUserAt: NOW }),
      chat('earlier', { lastUserAt: NOW - 5000 }),
      chat('latest', { lastUserAt: NOW - 10 }),
    ]);
    expect(rows.map((r) => r.tabId)).toEqual(['latest', 'earlier']);
  });

  it('is a screenful, not the archive', () => {
    const many = Array.from({ length: 100 }, (_, i) => chat(`c${i}`, { lastUserAt: NOW - i }));
    expect(activityChats(many)).toHaveLength(ACTIVITY_LIMIT);
  });
});

describe('sectionsOf', () => {
  it('puts every chat in Home and Search, and only some in Unread and Activity', () => {
    const unread = chat('u', { unread: true });
    const worker = chat('k', { unread: true, spawnedBy: 'u' });
    const all = [unread, worker];
    expect(sectionsOf(unread, all)).toEqual(['home', 'unread', 'activity', 'search']);
    expect(sectionsOf(worker, all)).toEqual(['home', 'search']);
  });
});

describe('shortAgo', () => {
  it('reads like a chat list, not a log', () => {
    expect(shortAgo(NOW - 5_000, NOW)).toBe('now');
    expect(shortAgo(NOW - 12 * 60_000, NOW)).toBe('12m');
    expect(shortAgo(null, NOW)).toBe('');
  });
});
