import { renderToStaticMarkup as html } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MentionChat, MentionRow } from '../lib/chat-mention';
import { ChatMentionCard, ChatMentionPicker, ChatMentionPill } from './ChatMentionPicker';

/**
 * What the browser is actually handed for the three `@` surfaces. Static markup
 * rather than a DOM library, like ChatPane's other component tests: the claims
 * worth defending are "the headline survived the move off the row", "the two
 * tiers stay separate and labelled", and "the combobox ids line up with what the
 * composer points `aria-activedescendant` at" — all of which are in the markup.
 */

function chat(over: Partial<MentionChat> & { tabName: string }): MentionChat {
  return {
    tabId: over.tabName.toLowerCase(),
    tabSlug: 'abc123',
    workspaceId: 'w1',
    workspaceSlug: 'personal',
    workspaceName: 'Personal',
    paneIds: [],
    chip: { name: over.tabName, icon: '📈' },
    ...over,
  };
}

const INV = chat({ tabName: 'Investing', headline: 'the portfolio and its theses' });
const FENCE = chat({
  tabName: 'quarterly budget notes',
  done: true,
  chip: { name: 'fence', done: true },
});

const picker = (rows: MentionRow[], opts?: { query?: string; searching?: boolean }) =>
  html(
    <ChatMentionPicker
      rows={rows}
      cursor={0}
      query={opts?.query ?? ''}
      listId="L"
      searching={opts?.searching ?? false}
      onPick={() => {}}
      onHover={() => {}}
    />,
  );

describe('the picker', () => {
  it('invites all three uses when nothing has been typed yet', () => {
    // `@` on its own has to say what it is FOR, or the gesture has no
    // discoverable surface at all.
    expect(picker([{ chat: INV, via: 'name' }])).toContain('reference, direct, or search');
  });

  it('shows the HEADLINE — the line that was taken off the sidebar row', () => {
    expect(picker([{ chat: INV, via: 'name' }])).toContain('the portfolio and its theses');
  });

  it('labels the content tier separately and keeps it below the name rows', () => {
    const out = picker(
      [
        { chat: INV, via: 'name' },
        { chat: FENCE, via: 'content', snippet: 'the «cash» position' },
      ],
      { query: 'cash' },
    );
    expect(out).toContain('matching');
    expect(out.indexOf('In messages')).toBeGreaterThan(out.indexOf('Investing'));
    // FTS5's own marks become a highlight, never raw guillemets on screen.
    expect(out).not.toContain('«');
    expect(out).toContain('<mark class="chat-mention-hit">cash</mark>');
  });

  it('gives every row the id the composer points aria-activedescendant at', () => {
    const out = picker([
      { chat: INV, via: 'name' },
      { chat: FENCE, via: 'name' },
    ]);
    expect(out).toContain('id="L-0"');
    expect(out).toContain('id="L-1"');
    expect(out).toContain('aria-selected="true"');
  });

  it('marks a done chat rather than hiding it — nothing is deleted', () => {
    expect(picker([{ chat: FENCE, via: 'name' }])).toContain('data-done="true"');
  });

  it('never lets the archive tier replace the rows already on screen', () => {
    const out = picker([{ chat: INV, via: 'name' }], { query: 'cash', searching: true });
    expect(out).toContain('Investing');
    expect(out).toContain('Searching messages…');
  });
});

describe('the inline pill', () => {
  it('is a button, and reads the chat’s own name', () => {
    const out = html(
      <ChatMentionPill chat={{ name: 'Investing', icon: '📈' }} onOpen={() => {}} />,
    );
    expect(out).toContain('<button');
    expect(out).toContain('Investing');
    // The 16px density: a 24px tile in a text line pushes the paragraph apart.
    expect(out).toContain('data-density="chip"');
  });
});

describe('the card', () => {
  it('spins in the one state slot while the other chat is working', () => {
    const out = html(
      <ChatMentionCard
        chat={{ name: 'Investing' }}
        sub="what's the cash position?"
        working
        onOpen={() => {}}
      />,
    );
    expect(out).toContain('chat-mention-card-mark');
    expect(out).not.toContain('chat-mention-card-state');
    expect(out).toContain('what&#x27;s the cash position?');
  });

  it('says what happened once it is not working', () => {
    const out = html(
      <ChatMentionCard chat={{ name: 'Investing' }} state="reported" onOpen={() => {}} />,
    );
    expect(out).toContain('reported');
    expect(out).not.toContain('chat-mention-card-mark');
  });

  it('gives a report the wider measure — it carries an answer, not a label', () => {
    const out = html(
      <ChatMentionCard chat={{ name: 'Investing' }} body={<>Cash is 12%.</>} onOpen={() => {}} />,
    );
    expect(out).toContain('-report');
    expect(out).toContain('Cash is 12%.');
  });
});
