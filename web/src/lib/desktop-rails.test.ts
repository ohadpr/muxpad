import { describe, expect, it } from 'vitest';
import {
  activityChats,
  currentWorkspaceSlug,
  railUnreadRows,
  unreadByWorkspace,
} from './chat-sections';
import type { SearchableTab } from './nav-search';

/**
 * The desktop rail: every workspace as a section, Home | Unread | Activity at
 * its top. Home is the tree; Unread and Activity are GLOBAL lists.
 */

const chat = (id: string, ws: string, extra: Partial<SearchableTab> = {}): SearchableTab => ({
  tabId: id,
  tabSlug: id,
  tabName: id,
  workspaceId: ws,
  workspaceSlug: ws,
  workspaceName: ws,
  paneIds: [],
  lastUserAt: 1000,
  ...extra,
});

// The corpus as it arrives: workspaces in YOUR order (p, then t, then r), and
// each workspace's rows in the server's stored order — pinned first, then
// manual positions, deliberately neither alphabetical nor by recency.
const corpus: SearchableTab[] = [
  chat('pin-b', 'p', { pinned: true, unread: true, lastUserAt: 10 }),
  chat('pin-a', 'p', { pinned: true, lastUserAt: 50 }),
  chat('zeta', 'p', { unread: true, lastUserAt: 900 }),
  chat('alpha', 'p', { lastUserAt: 700 }),
  chat('mid', 'p', { unread: true, lastUserAt: 20 }),
  chat('worker', 'p', { unread: true, spawnedBy: 'zeta', lastUserAt: 5000 }),
  chat('old', 'p', { done: true, unread: true, lastUserAt: 1 }),
  chat('t-2', 't', { unread: true, lastUserAt: 999 }),
  chat('t-1', 't', { lastUserAt: 800 }),
  chat('t-3', 't', { unread: true, lastUserAt: 30 }),
  chat('r-1', 'r', { lastUserAt: 600 }),
];

describe('Unread — a GLOBAL list, in the rail’s own order', () => {
  it('holds every workspace’s unread conversations, read top to bottom as the tree reads', () => {
    expect(railUnreadRows(corpus, null).map((t) => t.tabId)).toEqual([
      'pin-b',
      'zeta',
      'mid',
      'old',
      't-2',
      't-3',
    ]);
  });

  it('is a subsequence of the tree — no row changes places', () => {
    const ids = corpus.map((t) => t.tabId);
    const pos = railUnreadRows(corpus, 'alpha').map((t) => ids.indexOf(t.tabId));
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it('leaves sub-chats out, keeps a decayed unread chat', () => {
    const ids = railUnreadRows(corpus, null).map((t) => t.tabId);
    expect(ids).not.toContain('worker');
    expect(ids).toContain('old');
  });

  it('keeps the chat you are ON while you read it, and drops it once you leave', () => {
    const read = corpus.map((t) => (t.tabId === 't-3' ? { ...t, unread: false } : t));
    expect(railUnreadRows(read, 't-3').map((t) => t.tabId)).toContain('t-3');
    expect(railUnreadRows(read, 'zeta').map((t) => t.tabId)).not.toContain('t-3');
  });

  it('is empty when everything is read', () => {
    expect(railUnreadRows([chat('a', 'p'), chat('b', 't')], null)).toEqual([]);
  });
});

describe('Activity — a GLOBAL list, by when you touched it', () => {
  it('spans every workspace, no workers, nothing done', () => {
    expect(activityChats(corpus).map((t) => t.tabId)).toEqual([
      't-2',
      'zeta',
      't-1',
      'alpha',
      'r-1',
      'pin-a',
      't-3',
      'mid',
      'pin-b',
    ]);
  });
});

describe('the unread count a collapsed workspace header carries', () => {
  it('counts each workspace’s unread conversations — not workers — and none means none', () => {
    const badge = unreadByWorkspace(corpus);
    expect(badge.get('p')).toBe(4); // pin-b, zeta, mid, old
    expect(badge.get('t')).toBe(2);
    expect(badge.has('r')).toBe(false);
  });
});

describe('which workspace you are "in" on a page that names none', () => {
  const visible = [{ slug: 'p' }, { slug: 't' }, { slug: 'r' }];
  it('the URL’s, else the one you were last in, else the first; never a hidden one', () => {
    expect(currentWorkspaceSlug('t', 'p', visible)).toBe('t');
    expect(currentWorkspaceSlug(null, 'r', visible)).toBe('r');
    expect(currentWorkspaceSlug(null, null, visible)).toBe('p');
    expect(currentWorkspaceSlug('apps-container', 'gone', visible)).toBe('p');
  });
});
