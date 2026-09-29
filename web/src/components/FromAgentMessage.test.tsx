import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MentionChat } from '../lib/chat-mention';
import { FromAgentMessage, previewOf } from './FromAgentMessage';

// The house convention for the DOM-driven tests here (see ChatPane.spawn).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The same fixture shape ChatMentionPicker's own test builds. */
function chat(tabName: string): MentionChat {
  return {
    tabId: tabName.toLowerCase(),
    tabName,
    tabSlug: 'abc123',
    workspaceId: 'w1',
    workspaceSlug: 'personal',
    workspaceName: 'Personal',
    paneIds: [],
    chip: { name: tabName, icon: '🤖' },
  };
}

/** The conversation draws prose with `UserText`; the card only needs a node. */
const render = (t: string) => <span className="prose">{t}</span>;

const BRIEF = [
  'Take the sidebar work.',
  'Stage file by file.',
  'Report when done.',
  'Line four.',
].join('\n');

describe('FromAgentMessage', () => {
  it('names the chat that sent it', () => {
    const out = html(<FromAgentMessage from={chat('coordinator')} text="go" render={render} />);
    expect(out).toContain('coordinator');
    expect(out).toContain('sent this');
  });

  it('is a CARD, not a plain bubble', () => {
    const out = html(<FromAgentMessage from={chat('coordinator')} text="go" render={render} />);
    expect(out).toContain('chat-mention-card');
    expect(out).not.toContain('chat-bubble');
  });

  it('shows a preview and a way to see the rest when the message is long', () => {
    const out = html(<FromAgentMessage from={chat('coordinator')} text={BRIEF} render={render} />);
    expect(out).toContain('Take the sidebar work.');
    // The fourth line is behind the disclosure.
    expect(out).not.toContain('Line four.');
    expect(out).toContain('Show the work');
  });

  it('draws NO disclosure when the whole message already fits', () => {
    // A control that does nothing when pressed is worse than no control.
    const out = html(<FromAgentMessage from={chat('coordinator')} text="ping" render={render} />);
    expect(out).not.toContain('chat-mention-card-more');
  });

  it('shows the whole message once expanded, with no inner scroller', () => {
    // A scrolling region inside a scrolling log is a scroll trap — the reason
    // already written next to .chat-mention-card-work. The log is the scroller.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<FromAgentMessage from={chat('coordinator')} text={BRIEF} render={render} />);
    });
    const toggle = host.querySelector<HTMLButtonElement>('.chat-mention-card-more');
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());
    expect(host.textContent).toContain('Line four.');
    expect(host.querySelector('[data-expanded="true"]')).not.toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it('opens itself when a search landed in the part the preview cuts off', () => {
    // A highlight nobody can see is the same as no highlight — the rule the
    // action fold already follows.
    const out = html(
      <FromAgentMessage from={chat('coordinator')} text={BRIEF} render={render} forceOpen />,
    );
    expect(out).toContain('Line four.');
  });

  it('still draws a card when the sending chat has been deleted', () => {
    // "this came from another chat, and here it is" is true and useful without
    // a name. What it must not do is offer a link that goes nowhere.
    const out = html(<FromAgentMessage from={null} text="go" render={render} />);
    expect(out).toContain('another chat');
    expect(out).not.toContain('<button type="button" class="chat-mention-card-head"');
  });

  it('offers the link through to the sending chat when it resolves', () => {
    const out = html(
      <FromAgentMessage from={chat('coordinator')} text="go" render={render} onOpen={() => {}} />,
    );
    expect(out).toContain('<button type="button" class="chat-mention-card-head"');
  });
});

describe('previewOf', () => {
  it('keeps a short message whole and reports nothing hidden', () => {
    expect(previewOf('ping')).toEqual({ preview: 'ping', truncated: false });
  });

  it('cuts a multi-line brief to its opening lines', () => {
    const got = previewOf(BRIEF);
    expect(got.truncated).toBe(true);
    expect(got.preview.split('\n')).toHaveLength(3);
  });

  it('caps a single unbroken paragraph, which is otherwise one "line"', () => {
    const wall = 'word '.repeat(400).trim();
    const got = previewOf(wall);
    expect(got.truncated).toBe(true);
    expect(got.preview.length).toBeLessThanOrEqual(240);
  });

  it('cuts the long paragraph on a word boundary, not mid-token', () => {
    const wall = 'word '.repeat(400).trim();
    expect(previewOf(wall).preview.endsWith('word')).toBe(true);
  });

  it('reports nothing hidden for a message that is exactly the preview', () => {
    // Where a disclosure that does nothing would come from.
    const three = 'one\ntwo\nthree';
    expect(previewOf(three)).toEqual({ preview: three, truncated: false });
  });

  it('ignores the trailing whitespace a heredoc leaves behind', () => {
    expect(previewOf('one\ntwo\nthree\n')).toEqual({
      preview: 'one\ntwo\nthree',
      truncated: false,
    });
  });
});
