import { describe, expect, it } from 'vitest';
import {
  currentWorkspaceSlug,
  railActivityRows,
  railUnreadRows,
  unreadByWorkspace,
  workspaceMark,
} from './chat-sections';
import type { SearchableTab } from './nav-search';

/**
 * The desktop's two strips: a column of workspace icons, and the current
 * workspace's chat rail with Home | Unread | Activity. The pure rules — which
 * rows each view shows, which icon is current, where the badge comes from.
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

// One workspace's rows IN THE SERVER'S STORED ORDER (pinned first, then manual
// positions — deliberately neither alphabetical nor by recency), plus another
// workspace's rows interleaved, as the cross-workspace corpus carries them.
const corpus: SearchableTab[] = [
  chat('pin-b', 'p', { pinned: true, unread: true, lastUserAt: 10 }),
  chat('pin-a', 'p', { pinned: true, lastUserAt: 50 }),
  chat('zeta', 'p', { unread: true, lastUserAt: 900 }),
  chat('other-1', 't', { unread: true, lastUserAt: 999 }),
  chat('alpha', 'p', { lastUserAt: 700 }),
  chat('mid', 'p', { unread: true, lastUserAt: 20 }),
  chat('worker', 'p', { unread: true, spawnedBy: 'zeta', lastUserAt: 5000 }),
  chat('old', 'p', { done: true, unread: true, lastUserAt: 1 }),
  chat('other-2', 't', { unread: true }),
  chat('other-3', 'r'),
];

describe('the Unread view — a list of this workspace’s unread chats', () => {
  it('holds only this workspace’s unread conversations, IN THE RAIL’S ORDER — never re-sorted', () => {
    expect(railUnreadRows(corpus, 'p', null).map((t) => t.tabId)).toEqual([
      'pin-b',
      'zeta',
      'mid',
      'old',
    ]);
  });

  it('is a subsequence of the rail — no row changes places', () => {
    const ids = corpus.map((t) => t.tabId);
    const pos = railUnreadRows(corpus, 'p', 'alpha').map((t) => ids.indexOf(t.tabId));
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it('keeps an unread chat that has decayed into "older chats" — unread is unread', () => {
    expect(railUnreadRows(corpus, 'p', null).map((t) => t.tabId)).toContain('old');
  });

  it('leaves sub-chats out — their news is their parent’s unread already', () => {
    expect(railUnreadRows(corpus, 'p', null).map((t) => t.tabId)).not.toContain('worker');
  });

  it('keeps the chat you are ON while you read it, and drops it once you leave', () => {
    const read = corpus.map((t) => (t.tabId === 'mid' ? { ...t, unread: false } : t));
    expect(railUnreadRows(read, 'p', 'mid').map((t) => t.tabId)).toContain('mid');
    expect(railUnreadRows(read, 'p', 'zeta').map((t) => t.tabId)).not.toContain('mid');
  });

  it('is empty when the workspace is read — the other workspaces speak through their icons', () => {
    expect(railUnreadRows(corpus, 'r', null)).toEqual([]);
  });
});

describe('the Activity view', () => {
  it('is this workspace’s recents by when you touched them — no workers, nothing done', () => {
    expect(railActivityRows(corpus, 'p').map((t) => t.tabId)).toEqual([
      'zeta',
      'alpha',
      'pin-a',
      'mid',
      'pin-b',
    ]);
  });
});

describe('which workspace icon is current', () => {
  const visible = [{ slug: 'p' }, { slug: 't' }, { slug: 'r' }];

  it('the URL’s workspace', () => {
    expect(currentWorkspaceSlug('t', 'p', visible)).toBe('t');
  });

  it('on a page that names none (Artifacts, Apps, /activity), the one you came from', () => {
    expect(currentWorkspaceSlug(null, 'r', visible)).toBe('r');
  });

  it('on a cold open to such a page, the first workspace', () => {
    expect(currentWorkspaceSlug(null, null, visible)).toBe('p');
  });

  it('never a workspace the strip does not show (the hidden apps container)', () => {
    expect(currentWorkspaceSlug('apps-container', 'gone', visible)).toBe('p');
  });
});

describe('where the unread badge on a workspace icon comes from', () => {
  it('counts each workspace’s unread conversations from the cross-workspace corpus', () => {
    const badge = unreadByWorkspace(corpus);
    expect(badge.get('p')).toBe(4); // pin-b, zeta, mid, old — not the worker
    expect(badge.get('t')).toBe(2);
    expect(badge.has('r')).toBe(false); // nothing unread: no badge at all
  });
});

describe('workspaceMark — workspaces have no icon of their own', () => {
  it('is stable and legible at icon size', () => {
    expect(workspaceMark('Personal')).toBe('P');
    expect(workspaceMark('Trayo')).toBe('T');
    expect(workspaceMark('Side projects')).toBe('SP');
    expect(workspaceMark('  research ')).toBe('R');
    expect(workspaceMark('🏡 Home')).toBe('🏡');
    expect(workspaceMark('')).toBe('?');
    expect(workspaceMark('Side projects')).toBe(workspaceMark('Side projects'));
  });
});
