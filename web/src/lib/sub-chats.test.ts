import type { ChatAction } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import type { MentionChat } from './chat-mention';
import { artifactsOf, subChatIsOpen, subChatsOf } from './sub-chats';

/**
 * THE DRAWER'S TWO LISTS, as rules rather than as a rendered panel.
 *
 * What is IN a list decides what you can find — the same reason `groupChats`
 * is pure and tested. This one answers a different question from that one, and
 * the difference is the interesting part: the rail asks "what should the
 * navigation show", this asks "what did THIS conversation set in motion".
 */

const chat = (tabId: string, over: Partial<MentionChat> = {}): MentionChat =>
  ({
    tabId,
    tabSlug: tabId,
    tabName: tabId,
    workspaceId: 'w',
    workspaceSlug: 'w',
    workspaceName: 'W',
    paneIds: [`${tabId}-p`],
    chip: { name: tabId },
    ...over,
  }) as MentionChat;

describe('subChatsOf', () => {
  it('takes ONE HOP, not the flattened tree', () => {
    // A grandchild belongs in ITS parent's drawer, one click away. The rail
    // flattens arbitrary depth onto the root because it renders one indent
    // level; a drawer is read while looking at one conversation, and "what
    // this chat started" is a fact about this chat.
    const corpus = [
      chat('parent'),
      chat('child', { parentId: 'parent' }),
      chat('grandchild', { parentId: 'child' }),
    ];
    expect(subChatsOf(corpus, 'parent').map((s) => s.chat.tabId)).toEqual(['child']);
    expect(subChatsOf(corpus, 'child').map((s) => s.chat.tabId)).toEqual(['grandchild']);
  });

  it('holds the finished ones and the running ones together', () => {
    const corpus = [
      chat('parent'),
      chat('a', { parentId: 'parent', done: true }),
      chat('b', { parentId: 'parent' }),
    ];
    expect(subChatsOf(corpus, 'parent').map((s) => s.chat.tabId)).toEqual(['a', 'b']);
  });

  it('is OLDEST first — the list reads as a record of what happened', () => {
    const corpus = [
      chat('p'),
      chat('second', { parentId: 'p', createdAt: 2_000 }),
      chat('first', { parentId: 'p', createdAt: 1_000 }),
    ];
    expect(subChatsOf(corpus, 'p').map((s) => s.chat.tabId)).toEqual(['first', 'second']);
  });

  it('sorts a row with no timestamp LAST, not to the epoch', () => {
    // A server predating `created_at` on the row must not shove a worker to
    // the top of a history it has no place in.
    const corpus = [
      chat('p'),
      chat('stamped', { parentId: 'p', createdAt: 5_000 }),
      chat('unstamped', { parentId: 'p' }),
    ];
    expect(subChatsOf(corpus, 'p').map((s) => s.chat.tabId)).toEqual(['stamped', 'unstamped']);
  });

  it('carries the pane to mount, and null when there is none', () => {
    const corpus = [
      chat('p'),
      chat('kid', { parentId: 'p' }),
      chat('paneless', { parentId: 'p', paneIds: [] }),
    ];
    const subs = subChatsOf(corpus, 'p');
    expect(subs.find((s) => s.chat.tabId === 'kid')?.paneId).toBe('kid-p');
    // Still in the list — it is part of the record — just not openable.
    expect(subs.find((s) => s.chat.tabId === 'paneless')?.paneId).toBe(null);
  });

  it('never lists a chat under itself', () => {
    // A `spawned_by` loop should be impossible; a list that decides what you
    // can see is the wrong place to find out that it wasn’t.
    expect(subChatsOf([chat('loop', { parentId: 'loop' })], 'loop')).toEqual([]);
  });

  it('is empty-safe, and empty for no chat at all', () => {
    expect(subChatsOf([], 'p')).toEqual([]);
    expect(subChatsOf([chat('kid', { parentId: 'p' })], '')).toEqual([]);
  });

  it('reads `done` as "has it reported", which is what the list is asking', () => {
    // A sub-chat retires the moment it delivers, so this is not "is its
    // process alive". A crashed worker reads as finished here: it is not
    // coming back, and its card in the log is where the crash is said.
    expect(subChatIsOpen({ chat: chat('a'), paneId: null })).toBe(true);
    expect(subChatIsOpen({ chat: chat('a', { done: true }), paneId: null })).toBe(false);
  });
});

describe('artifactsOf', () => {
  const act = (over: Partial<ChatAction> = {}): ChatAction => ({
    id: 'x',
    pane_id: 'p',
    at: 1_000,
    kind: 'publish.create',
    title: 'Published thing',
    url: 'https://pub.example/thing/',
    state: 'sent',
    ...over,
  });

  it('keeps both of a republished name — they are two events', () => {
    // The older link is what somebody may already have pasted somewhere, and
    // collapsing them would hide that the thing was updated.
    const rows = artifactsOf([act({ id: 'v1', at: 1_000 }), act({ id: 'v2', at: 2_000 })]);
    expect(rows.map((r) => r.id)).toEqual(['v2', 'v1']);
  });

  it('ignores everything that is not a publish with a link', () => {
    expect(
      artifactsOf([act({ kind: 'slack.post' }), act({ url: null }), act({ url: undefined })]),
    ).toEqual([]);
  });
});
