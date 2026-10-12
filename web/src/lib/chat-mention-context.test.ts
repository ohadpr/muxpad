import { describe, expect, it } from 'vitest';
import { mentionedChats } from './chat-mention';
import type { MentionChat } from './chat-mention';

/**
 * A mention resolves to a HANDLE now, not a route. The rule it replaced sent
 * the message to the mentioned chat; this collects what was mentioned so the
 * agent receiving the message can decide for itself.
 */
const chat = (name: string, id: string, panes: string[] = [`p-${id}`]): MentionChat =>
  ({
    tabId: id,
    tabSlug: id,
    tabName: name,
    workspaceId: 'w',
    workspaceSlug: 'w',
    workspaceName: 'W',
    paneIds: panes,
  }) as MentionChat;

const corpus = [chat('Investing', 'T1'), chat('Main', 'T2'), chat('Main repo', 'T3')];

describe('mentionedChats', () => {
  it('finds a mention wherever it sits in the sentence', () => {
    // The old rule only acted on a LEADING mention; context does not care where
    // the name appears.
    expect(mentionedChats('what did @Investing decide?', corpus).map((c) => c.tabId)).toEqual([
      'T1',
    ]);
    expect(mentionedChats('@Investing what did we decide?', corpus).map((c) => c.tabId)).toEqual([
      'T1',
    ]);
  });

  it('carries the pane ids, which is the point', () => {
    expect(mentionedChats('see @Investing', corpus)[0]).toMatchObject({
      name: 'Investing',
      tabId: 'T1',
      paneIds: ['p-T1'],
    });
  });

  it('prefers the LONGEST name — @Main repo is not @Main', () => {
    expect(mentionedChats('check @Main repo please', corpus).map((c) => c.tabId)).toEqual(['T3']);
  });

  it('dedupes one chat named twice', () => {
    // A block listing it twice invites the reader to think there are two.
    expect(mentionedChats('@Main and again @Main', corpus)).toHaveLength(1);
  });

  it('collects several, in order', () => {
    expect(mentionedChats('@Investing then @Main', corpus).map((c) => c.tabId)).toEqual([
      'T1',
      'T2',
    ]);
  });

  it('an explicit pick outranks the name', () => {
    // Two chats can share a name; what the user chose in the picker is the
    // stronger evidence, exactly as the old directive parser had it.
    const picks = [{ start: 0, name: 'Main', tabId: 'T3' }];
    expect(mentionedChats('@Main go', corpus, picks).map((c) => c.tabId)).toEqual(['T3']);
  });

  it('ignores a pick whose token has been edited away', () => {
    const picks = [{ start: 0, name: 'Main', tabId: 'T3' }];
    expect(mentionedChats('nothing here', corpus, picks)).toEqual([]);
  });

  it('an unknown @word is just text', () => {
    expect(mentionedChats('@nobody hello', corpus)).toEqual([]);
  });

  it('a message with no mentions resolves to nothing', () => {
    expect(mentionedChats('plain message', corpus)).toEqual([]);
  });
});
