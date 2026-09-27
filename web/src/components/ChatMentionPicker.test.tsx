import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('says a retired sub-chat DELIVERED, and whose work it was', () => {
    // After the amendment a sub-chat leaves the live list the moment it reports,
    // so this list is one of the two ways back to it. Its name is the task
    // ("Work review"); "delivered · under muxpad sidebar" is what makes it
    // recognisable — and tells two same-named sub-chats apart.
    const sub = chat({
      tabName: 'Work review',
      done: true,
      doneReason: 'delivered',
      parentName: 'muxpad sidebar',
    });
    const out = picker([{ chat: sub, via: 'name' }]);
    expect(out).toContain('delivered · under muxpad sidebar');
  });

  it('adds nothing to an ordinary live row', () => {
    // The common row must not grow a tag for the uncommon case.
    expect(picker([{ chat: INV, via: 'name' }])).not.toContain('chat-mention-under');
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

  it('draws no control at all when there is nowhere to go', () => {
    // A report from a chat that cannot be resolved still draws — a name and an
    // answer beats a bubble of XML. What it must not do is offer a button whose
    // click does nothing, which is exactly what a fresh load into a conversation
    // with an empty composer used to render.
    const out = html(<ChatMentionCard chat={{ name: 'another chat' }} state="reported" />);
    expect(out).toContain('another chat');
    expect(out).not.toContain('<button');
  });
});

/**
 * THE STATE READS AS A STATE, AND THE WORK IS ONE CLICK AWAY.
 *
 * "'delivered' feels weird — use icons or make the text look better. also this
 * card is a bit dull, make it a bit nicer." It was mono grey 10.5px text in the
 * slot where the rest of the app draws its state language, so it read as a
 * leftover debug string rather than as "this finished".
 *
 * And the other half of the same card: "the summary when it shows should have an
 * expand button to show the archived sub-chat or something."
 */
describe('the card says what happened, in the app state language', () => {
  it('draws the state as a hued chip, outside the link', () => {
    // OUTSIDE the head, which is StateChip's own rule and not a detail: text
    // inside a control joins that control's accessible NAME, so the link would
    // be announced as "Work review, delivered" and rename itself every time an
    // agent started or stopped.
    const out = html(
      <ChatMentionCard
        chat={{ name: 'Work review' }}
        state="delivered"
        tone="delivered"
        onOpen={() => {}}
      />,
    );
    expect(out).toContain('data-state="delivered"');
    expect(out).toMatch(/<\/button>\s*<span class="chat-mention-card-state"/);
  });

  it('gives an unlabelled state a NEUTRAL tone rather than a lifecycle hue', () => {
    // The `@` card's words ("reported", "directed here") are annotations, not
    // lifecycle states, and they must not borrow the green that means finished.
    const out = html(<ChatMentionCard chat={{ name: 'Investing' }} state="reported" />);
    expect(out).toContain('data-state="note"');
  });

  it('offers the disclosure ONLY when the caller can answer it', () => {
    // A prop with no handler would be a control that does nothing — the dead
    // affordance the 77c1583 revert was about.
    const bare = html(<ChatMentionCard chat={{ name: 'Work review' }} state="delivered" />);
    expect(bare).not.toContain('chat-mention-card-more');
    const expandable = html(
      <ChatMentionCard
        chat={{ name: 'Work review' }}
        state="delivered"
        body={<>Read 14 pages.</>}
        onToggleExpanded={() => {}}
      />,
    );
    expect(expandable).toContain('chat-mention-card-more');
    expect(expandable).toContain('aria-expanded="false"');
  });

  it('keeps the summary visible when it expands — the work is added, not swapped', () => {
    // Collapsed shows the summary; expanded shows the summary AND the work. The
    // summary is the index, so losing it on expand would lose the one line that
    // says where to look.
    const out = html(
      <ChatMentionCard
        chat={{ name: 'Work review' }}
        state="delivered"
        body={<>Read 14 pages and wrote /tmp/x.md.</>}
        expanded
        work={'# Findings'}
        onToggleExpanded={() => {}}
      />,
    );
    expect(out).toContain('Read 14 pages and wrote /tmp/x.md.');
    expect(out).toContain('# Findings');
    expect(out).toContain('aria-expanded="true"');
  });

  it('keeps the HEAD LINK alongside the disclosure — read here, or go there', () => {
    const out = html(
      <ChatMentionCard
        chat={{ name: 'Work review' }}
        state="delivered"
        body={<>a summary</>}
        onOpen={() => {}}
        onToggleExpanded={() => {}}
      />,
    );
    expect(out).toContain('chat-mention-card-head');
    expect(out).toContain('chat-mention-card-more');
  });
});

/**
 * A REPORT'S BODY IS NOT INSIDE THE LINK.
 *
 * The card was one big `<button>`, and a report's body is the other agent's
 * answer rendered in full — mentions included, and a mention is a
 * `ChatMentionPill`, which is also a button. So "see @Investing" in a report was
 * a button inside a button: the pill's click ran, then bubbled to the card, and
 * the card navigated back to the reporting chat — defeating the reference that
 * was clicked. Mounted and clicked, because the bubbling IS the defect and no
 * assertion about markup alone would name it.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('clicking a mention inside a report goes to the mention, once', () => {
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  /** The production composition: a report card whose body holds a resolved pill. */
  function mountReport(openReport: () => void, openMention: () => void) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <ChatMentionCard
          chat={{ name: 'Work review' }}
          state="reported"
          onOpen={openReport}
          body={
            <>
              {'see '}
              <ChatMentionPill chat={{ name: 'Investing' }} onOpen={openMention} />
            </>
          }
        />,
      );
    });
    return host;
  }

  it('fires the pill’s handler and NOT the card’s', () => {
    const openReport = vi.fn();
    const openMention = vi.fn();
    const box = mountReport(openReport, openMention);
    const pill = box.querySelector<HTMLButtonElement>('.chat-mention-pill');
    expect(pill).not.toBeNull();
    act(() => pill?.click());
    expect(openMention).toHaveBeenCalledTimes(1);
    // The whole finding: this used to be 1, so the navigation the user asked for
    // was undone by the container in the same click.
    expect(openReport).not.toHaveBeenCalled();
  });

  it('still navigates to the reporting chat from the card’s head', () => {
    // The affordance the card exists for has to survive the fix.
    const openReport = vi.fn();
    const openMention = vi.fn();
    const box = mountReport(openReport, openMention);
    act(() => box.querySelector<HTMLButtonElement>('.chat-mention-card-head')?.click());
    expect(openReport).toHaveBeenCalledTimes(1);
    expect(openMention).not.toHaveBeenCalled();
  });

  it('nests no button inside another, anywhere in the card', () => {
    // The structural statement of the same thing — and it is also invalid DOM
    // nesting, which React warns about on every render.
    const box = mountReport(vi.fn(), vi.fn());
    expect(box.querySelector('button button')).toBeNull();
  });
});

/**
 * THE CARD IN SIX THEMES — the CSS contract, read off the stylesheet.
 *
 * Rules rather than computed pixels, for StateChip.test's reason: jsdom does not
 * implement color-mix, so a computed-style assertion here would be testing jsdom.
 * What IS checkable, and what actually breaks, is whether a value was written as
 * a colour instead of derived from a token — tokyo-night, dracula, alucard,
 * github-light, acme and acme-dark re-step every one of them, and a hex in this
 * sheet is a card that looks tuned on one theme and wrong on the other five.
 */
describe('the card names no colour of its own', () => {
  const CSS = readFileSync(join(import.meta.dirname, 'ChatMentionPicker.css'), 'utf8');
  /** Every declaration inside a `.chat-mention-card*` rule. */
  const CARD_RULES = CSS.split('}')
    .filter((block) => /\.chat-mention-card[\w-]*[^{]*\{/.test(block))
    .join('}');

  it('uses no hex or named colour anywhere in the card', () => {
    // `rgb(0 0 0 / …)` is the ONE exception and it is deliberate: a shadow has to
    // be black at low alpha on every theme, because one mixed from --chat-fg
    // would be a white glow on the four dark ones.
    const withoutShadows = CARD_RULES.replace(/box-shadow:[^;]+;/g, '');
    expect(withoutShadows).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutShadows).not.toMatch(/\b(?:rgba?|hsla?)\(/);
  });

  it('draws each state from the status channel, never from --accent or --danger', () => {
    // The channel's own rule: it must not change hue with the theme, and every
    // theme re-tunes --danger to fit its palette.
    expect(CARD_RULES).toContain('--state-hue: var(--status-ready)');
    expect(CARD_RULES).toContain('--state-hue: var(--status-dead)');
    const stateRules = CSS.split('}')
      .filter((b) => b.includes('.chat-mention-card-state['))
      .join('}');
    expect(stateRules).not.toMatch(/--danger|--chat-accent/);
  });

  it('does not put a scroller inside the log', () => {
    // A scrolling region inside a scrolling document is a scroll trap: the wheel
    // stops working depending on where the pointer is. The expansion is bounded
    // at the FETCH instead (lib/spawn-work.ts).
    const work = CSS.split('}')
      .filter((b) => b.includes('.chat-mention-card-work'))
      .join('}');
    expect(work).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    expect(work).not.toMatch(/max-height/);
  });

  it('keeps the card shrunk to its contents', () => {
    // It was a fixed `min(420px, 94%)`, which drew a spawn card for `count-todos`
    // as a 420px pill holding 90px of text. The `-report` rule still sets a
    // measure, because a body needs one.
    const base = CSS.split('}').find((b) => /\.chat-mention-card\s*\{/.test(b)) ?? '';
    expect(base).toContain('width: fit-content');
  });
});

/**
 * WHICH WORKSPACE — the column that makes two identical names pickable apart.
 *
 * The `@` list is the only surface that spans workspaces. The sidebar shows one
 * at a time, so a chat name is unique THERE and is not unique here: searching
 * "main" returned a `Main` from Trayo and a `Main` from Trayobot as two rows
 * distinguished only by an emoji and whatever headline each happened to carry.
 * Picking the wrong one directs work to the wrong chat, which is the failure
 * this grammar exists to prevent.
 */
describe('a mention row says which workspace the chat is in', () => {
  it('tells two identically-named chats apart', () => {
    const out = picker(
      [
        { chat: chat({ tabName: 'Main', workspaceName: 'Trayo' }), via: 'name' },
        { chat: chat({ tabName: 'Main', workspaceName: 'Trayobot' }), via: 'name' },
      ],
      { query: 'main' },
    );
    expect(out).toContain('Trayo<');
    expect(out).toContain('Trayobot<');
  });

  it('shows it on an ORDINARY live row, not only a delivered or nested one', () => {
    // The two colliding names are both plain chats, so a tag that appeared only
    // for delivered or nested rows would not have separated them. `provenance`
    // is deliberately empty here — this is a second, always-on column, not a
    // longer version of that one.
    const out = picker([{ chat: INV, via: 'name' }]);
    expect(out.split('chat-mention-ws').length - 1).toBe(1);
    expect(out).toContain('Personal<');
    expect(out).not.toContain('chat-mention-under');
  });
});
