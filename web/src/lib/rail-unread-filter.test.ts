import { describe, expect, it } from 'vitest';
import { previewLine } from '../components/ChatPreviewList';
import {
  activityChats,
  isUnreadTab,
  unreadCount,
  unreadFilterActive,
  unreadFilterRows,
  unreadFilterWorkspaces,
} from './chat-sections';
import type { SearchableTab } from './nav-search';

/**
 * The desktop rail's Unread FILTER, and the Activity destination. The two
 * questions read first: which rows the filter keeps, and what Activity holds.
 */

type Row = { id: string; unread?: boolean; spawned_by?: string | null; pinned?: boolean };
const row = (id: string, extra: Partial<Row> = {}): Row => ({ id, ...extra });

describe('which rows the Unread filter keeps', () => {
  // A workspace's list as the server orders it: pinned block, then the rest,
  // in their MANUAL positions — deliberately not alphabetical, not by recency.
  const list: Row[] = [
    row('pin-b', { pinned: true, unread: true }),
    row('pin-a', { pinned: true }),
    row('pin-c', { pinned: true, unread: true }),
    row('zeta', { unread: true }),
    row('alpha'),
    row('mid', { unread: true }),
    row('worker', { unread: true, spawned_by: 'zeta' }),
    row('omega'),
  ];

  it('keeps only the unread chats, IN THE ORDER THEY ALREADY HAD — hiding, never sorting', () => {
    expect(unreadFilterRows(list, null).map((r) => r.id)).toEqual([
      'pin-b',
      'pin-c',
      'zeta',
      'mid',
    ]);
  });

  it('keeps the pinned block ahead of the rest, because it never moved it', () => {
    const kept = unreadFilterRows(list, null);
    const firstUnpinned = kept.findIndex((r) => !r.pinned);
    expect(kept.slice(0, firstUnpinned).every((r) => r.pinned)).toBe(true);
    expect(kept.slice(firstUnpinned).some((r) => r.pinned)).toBe(false);
  });

  it('is a subsequence of the unfiltered list — no row can change places', () => {
    const kept = unreadFilterRows(list, 'alpha').map((r) => r.id);
    const positions = kept.map((id) => list.findIndex((r) => r.id === id));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keeps the row you are ON, read or not — opening it must not yank it away', () => {
    // You click `mid`; reading it clears the flag; it stays until you leave.
    const afterReading = list.map((r) => (r.id === 'mid' ? { ...r, unread: false } : r));
    expect(unreadFilterRows(afterReading, 'mid').map((r) => r.id)).toContain('mid');
    // …and goes once you are somewhere else.
    expect(unreadFilterRows(afterReading, 'zeta').map((r) => r.id)).not.toContain('mid');
  });

  it('leaves sub-chats out — their news is their parent’s unread already', () => {
    expect(unreadFilterRows(list, null).map((r) => r.id)).not.toContain('worker');
    expect(isUnreadTab({ unread: true, spawned_by: 'p' })).toBe(false);
  });
});

const chat = (id: string, ws: string, extra: Partial<SearchableTab> = {}): SearchableTab => ({
  tabId: id,
  tabSlug: id,
  tabName: id,
  workspaceId: ws,
  workspaceSlug: ws,
  workspaceName: ws.toUpperCase(),
  paneIds: [],
  lastUserAt: 1000,
  ...extra,
});

describe('when the filter is actually filtering', () => {
  it('only while there is something unread — at zero it falls back to the whole rail', () => {
    expect(unreadFilterActive(true, 3)).toBe(true);
    expect(unreadFilterActive(true, 0)).toBe(false);
    expect(unreadFilterActive(false, 3)).toBe(false);
  });

  it('counts unread conversations, not workers', () => {
    expect(
      unreadCount([
        chat('a', 'w', { unread: true }),
        chat('b', 'w'),
        chat('k', 'w', { unread: true, spawnedBy: 'a' }),
      ]),
    ).toBe(1);
  });

  it('shows the workspaces holding an unread chat, plus the one you are in, in your order', () => {
    const workspaces = [
      { id: 'w3', slug: 'w3' },
      { id: 'w1', slug: 'w1' },
      { id: 'w2', slug: 'w2' },
      { id: 'w4', slug: 'w4' },
    ];
    const corpus = [chat('x', 'w2', { unread: true }), chat('y', 'w3', { unread: true })];
    expect(unreadFilterWorkspaces(workspaces, corpus, 'w4').map((w) => w.id)).toEqual([
      'w3',
      'w2',
      'w4',
    ]);
  });
});

describe('what Activity holds', () => {
  it('recent conversations by when you touched them — no sub-chats, nothing done', () => {
    const rows = activityChats([
      chat('worker', 'w', { spawnedBy: 'p', lastUserAt: 9999 }),
      chat('old', 'w', { done: true, lastUserAt: 9998 }),
      chat('b', 'w', { lastUserAt: 500 }),
      chat('a', 'w', { lastUserAt: 900 }),
    ]);
    expect(rows.map((r) => r.tabId)).toEqual(['a', 'b']);
  });
});

describe('what a row says when it has no preview', () => {
  it('the last message, "You: " when it was yours', () => {
    expect(previewLine({ text: 'done', by: 'assistant' }, 'topic', true)).toEqual({
      kind: 'message',
      text: 'done',
    });
    expect(previewLine({ text: 'ship it', by: 'user' }, undefined, true).text).toBe('You: ship it');
  });

  it('a chat on another machine says so, deliberately — not a blank, not the topic', () => {
    expect(previewLine({ elsewhere: true }, 'topic', true).kind).toBe('elsewhere');
  });

  it('where the host has not asked for that (the phone), it falls back as before', () => {
    expect(previewLine({ elsewhere: true }, 'topic', false)).toEqual({
      kind: 'fallback',
      text: 'topic',
    });
    expect(previewLine(null, undefined, false).kind).toBe('none');
  });
});
