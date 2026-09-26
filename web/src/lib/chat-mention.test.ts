// The `@` mention grammar. Pure functions, tested directly: the three readings
// of a mention (reference / direction / search) are one parse, and the bugs that
// matter are "it sent work to the wrong chat" and "the picker hovered over my
// whole sentence" — neither of which a rendered assertion would name.
import { describe, expect, it } from 'vitest';
import {
  MENTION_QUERY_MAX,
  type MentionChat,
  applyMention,
  detectMentionRun,
  nextMentionRun,
  parseDirectMarker,
  parseDirective,
  parseMentions,
  parseReportMarker,
  rankMentions,
  renderDirectMarker,
  renderReportMarker,
  runIsSettled,
  toMentionChats,
  withContentRows,
} from './chat-mention';
import type { WorkspaceTabs } from './nav-search';

function chat(over: Partial<MentionChat> & { tabName: string }): MentionChat {
  return {
    tabId: over.tabName.toLowerCase().replace(/\s+/g, '-'),
    tabSlug: 'abc123',
    workspaceId: 'w1',
    workspaceSlug: 'personal',
    workspaceName: 'Personal',
    paneIds: [],
    chip: { name: over.tabName },
    ...over,
  };
}

const CORPUS = [
  chat({ tabName: 'Investing', paneIds: ['p-inv'], lastActivityAt: 300 }),
  chat({ tabName: 'Main', paneIds: ['p-main'], lastActivityAt: 200 }),
  chat({ tabName: 'Main repo', paneIds: ['p-repo'], lastActivityAt: 100 }),
  chat({ tabName: 'quarterly budget notes', paneIds: ['p-budget'], done: true, lastActivityAt: 400 }),
];

describe('detectMentionRun — when the picker is open', () => {
  it('opens on a bare @ at the start of the draft', () => {
    expect(detectMentionRun('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('opens after whitespace and keeps the query behind the caret', () => {
    expect(detectMentionRun('ask @inv', 8)).toEqual({ start: 4, end: 8, query: 'inv' });
  });

  it('keeps spaces in the query — chat names and search phrases have them', () => {
    // "@cash position" must reach the content tier as a phrase, so a space
    // cannot be what ends the run.
    expect(detectMentionRun('@cash position', 14)?.query).toBe('cash position');
  });

  it('is driven by the CARET, not by the end of the draft', () => {
    // Editing a mention mid-sentence must reopen the picker on THAT run.
    expect(detectMentionRun('@inv and then some more', 4)).toEqual({
      start: 0,
      end: 4,
      query: 'inv',
    });
  });

  it('does not treat an email address as a mention', () => {
    expect(detectMentionRun('mail me@example.com', 19)).toBeNull();
  });

  it('closes on a newline, a second @, and past the length cap', () => {
    expect(detectMentionRun('@inv\nnext', 9)).toBeNull();
    expect(detectMentionRun('@a @b', 2)).not.toBeNull(); // the LAST @ wins
    expect(
      detectMentionRun(`@${'x'.repeat(MENTION_QUERY_MAX + 1)}`, MENTION_QUERY_MAX + 2),
    ).toBeNull();
  });
});

describe('runIsSettled — the picker gets out of the way', () => {
  it('is settled once a known name is followed by a space', () => {
    expect(runIsSettled("Investing what's the cash", CORPUS)).toBe(true);
  });

  it('is not settled while the name is still being typed', () => {
    expect(runIsSettled('Invest', CORPUS)).toBe(false);
    expect(runIsSettled('Investing', CORPUS)).toBe(false);
  });
});

describe('nextMentionRun — every reason the picker closes, in one place', () => {
  it('is open while a name is being typed', () => {
    expect(nextMentionRun('@inv', 4, CORPUS, null)?.query).toBe('inv');
  });

  it('closes once the name is chosen and the request has started', () => {
    // The single most important one: the picker must not hover over the sentence
    // you type after choosing, and Enter must go back to meaning "send".
    expect(nextMentionRun("@Investing what's the cash", 26, CORPUS, null)).toBeNull();
  });

  it('stays closed for the run Escape was pressed on', () => {
    expect(nextMentionRun('@inv', 4, CORPUS, 0)).toBeNull();
    // …and typing more into that same run does not bring it back.
    expect(nextMentionRun('@invest', 7, CORPUS, 0)).toBeNull();
  });

  it('opens again for a NEW @ — a dismissal is not a mode', () => {
    expect(nextMentionRun('@inv and @ma', 12, CORPUS, 0)?.query).toBe('ma');
  });
});

describe('applyMention — what picking inserts', () => {
  it('replaces the run with the name and a trailing space, and says where the caret goes', () => {
    const run = detectMentionRun('ask @inv about it', 8);
    if (!run) throw new Error('expected a run');
    const next = applyMention('ask @inv about it', run, CORPUS[0] as MentionChat);
    expect(next.text).toBe('ask @Investing about it');
    // Caret lands after the inserted space, NOT at the end of the draft — the
    // rest of the sentence was already written.
    expect(next.caret).toBe('ask @Investing '.length);
  });
});

describe('parseMentions — chips in rendered text', () => {
  it('splits prose from mentions', () => {
    const parts = parseMentions('see @Investing for that', CORPUS);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'mention', 'text']);
    expect(parts[1]).toMatchObject({ text: '@Investing' });
  });

  it('prefers the LONGEST name — @Main repo is not @Main', () => {
    const parts = parseMentions('@Main repo please', CORPUS);
    const mention = parts.find((p) => p.kind === 'mention');
    expect(mention?.kind === 'mention' && mention.chat.tabName).toBe('Main repo');
  });

  it('leaves an unknown @word as plain text', () => {
    expect(parseMentions('@nobody here', CORPUS)).toEqual([{ kind: 'text', text: '@nobody here' }]);
  });

  it('matches case-insensitively but keeps what the user typed', () => {
    const parts = parseMentions('@investing', CORPUS);
    expect(parts[0]).toMatchObject({ kind: 'mention', text: '@investing' });
  });

  it('does not match a name that is only a prefix of the typed word', () => {
    expect(parseMentions('@Mainframe', CORPUS)).toEqual([{ kind: 'text', text: '@Mainframe' }]);
  });
});

describe('parseDirective — only a LEADING mention directs work', () => {
  it('reads @Name + text as a direction', () => {
    const d = parseDirective("@Investing what's the cash position?", CORPUS);
    expect(d?.target.tabName).toBe('Investing');
    expect(d?.body).toBe("what's the cash position?");
  });

  it('is not a direction when the mention is mid-sentence', () => {
    // "ask @Investing about this later" is a note to self. Routing it away from
    // the chat the user was typing in would be the worst thing here.
    expect(parseDirective('ask @Investing about this later', CORPUS)).toBeNull();
  });

  it('is not a direction when there is no body — that is a reference', () => {
    expect(parseDirective('@Investing', CORPUS)).toBeNull();
    expect(parseDirective('@Investing   ', CORPUS)).toBeNull();
  });

  it('resolves the longest name, so the request reaches the right chat', () => {
    const d = parseDirective('@Main repo run the tests', CORPUS);
    expect(d?.target.tabName).toBe('Main repo');
    expect(d?.body).toBe('run the tests');
  });
});

describe('the markers — one grammar, both directions', () => {
  it('round-trips a direction', () => {
    const marker = { id: 'd1', from: 'muxpad sidebar', pane: 'pane-1' };
    const text = renderDirectMarker(marker, 'run the tests');
    const parsed = parseDirectMarker(text);
    expect(parsed?.marker).toEqual(marker);
    expect(parsed?.body.trim()).toBe('run the tests');
    // The block is a real instruction, not just a render hook: the receiving
    // agent has to be told where to send the answer.
    expect(text).toContain('muxpad agent send pane-1');
  });

  it('pre-fills the whole report line, so the other agent only writes prose', () => {
    const text = renderDirectMarker(
      { id: 'd1', from: 'muxpad', pane: 'pane-1', to: 'Investing', toPane: 'pane-2' },
      'check the cash',
    );
    // The report template inside the instruction must itself parse — it is the
    // string the answer will be made of.
    const template = text.slice(text.indexOf('<muxpad-report'));
    expect(parseReportMarker(template)?.marker).toEqual({
      id: 'd1',
      from: 'Investing',
      pane: 'pane-2',
    });
  });

  it('escapes a chat name that would otherwise break the attribute', () => {
    const text = renderDirectMarker({ id: 'd1', from: 'say "hi" <b>', pane: 'p' }, 'x');
    expect(parseDirectMarker(text)?.marker.from).toBe('say "hi" <b>');
  });

  it('round-trips a report', () => {
    const marker = { id: 'd1', from: 'Investing', pane: 'pane-2' };
    const text = renderReportMarker(marker, 'Cash is 12%.');
    expect(parseReportMarker(text)).toEqual({ marker, body: 'Cash is 12%.' });
  });

  it('accepts a report the other agent typed loosely', () => {
    // Written by a DIFFERENT agent from an instruction, so every plausible slip
    // has to land as a card rather than as raw XML in a bubble.
    // No closing tag, no id:
    expect(parseReportMarker('  <muxpad-report>  \n\nDone: 12%.')).toEqual({
      marker: { id: '', from: '', pane: '' },
      body: 'Done: 12%.',
    });
    // Attributes dropped or reordered:
    expect(parseReportMarker('<muxpad-report from="X" id="d1"></muxpad-report>\nDone.')).toEqual({
      marker: { id: 'd1', from: 'X', pane: '' },
      body: 'Done.',
    });
    // The answer written INSIDE the element instead of after it:
    expect(parseReportMarker('<muxpad-report id="d1">Cash is 12%.</muxpad-report>')).toEqual({
      marker: { id: 'd1', from: '', pane: '' },
      body: 'Cash is 12%.',
    });
  });

  it('ignores text that merely mentions the tag mid-message', () => {
    expect(
      parseReportMarker('I will write <muxpad-report id="x"></muxpad-report> later'),
    ).toBeNull();
    expect(parseDirectMarker('about <muxpad-direct id="x"></muxpad-direct>')).toBeNull();
  });
});

describe('rankMentions', () => {
  it('offers something for a bare @ — live first, then most recent', () => {
    const rows = rankMentions(CORPUS, '', {});
    expect(rows.map((r) => r.chat.tabName)).toEqual([
      'Investing',
      'Main',
      'Main repo',
      // done sinks below every live chat even though it is the most recent
      'quarterly budget notes',
    ]);
  });

  it('excludes the chat you are typing in', () => {
    const rows = rankMentions(CORPUS, '', { excludeTabId: 'investing' });
    expect(rows.map((r) => r.chat.tabName)).not.toContain('Investing');
  });

  it('ranks names and reports the range to highlight', () => {
    const rows = rankMentions(CORPUS, 'damage', {});
    expect(rows[0]?.chat.tabName).toBe('quarterly budget notes');
    expect(rows[0]?.nameRange).toEqual([6, 12]);
  });

  it('finds done chats by name — the picker covers live AND done', () => {
    expect(rankMentions(CORPUS, 'fence', {}).map((r) => r.chat.tabName)).toEqual([
      'quarterly budget notes',
    ]);
  });
});

describe('withContentRows — the archive tier', () => {
  const hit = (paneId: string | null, snippet = 'the «cash» position') => ({
    sid: `s-${paneId}`,
    ts: 1,
    role: 'user',
    snippet,
    session: paneId ? { pane_id: paneId } : {},
  });

  it('resolves a hit to its chat through the pane index', () => {
    const rows = withContentRows([], [hit('p-budget')] as never, CORPUS, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ via: 'content', snippet: 'the «cash» position' });
    expect(rows[0]?.chat.tabName).toBe('quarterly budget notes');
  });

  it('never repeats a chat already matched by name', () => {
    const nameRows = rankMentions(CORPUS, 'fence', {});
    const rows = withContentRows(nameRows, [hit('p-budget')] as never, CORPUS, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.via).toBe('name');
  });

  it('drops hits with no pane, and hits whose pane belongs to no chat', () => {
    expect(withContentRows([], [hit(null), hit('p-gone')] as never, CORPUS, {})).toEqual([]);
  });

  it('keeps one row per chat and honours the limit', () => {
    const hits = [hit('p-inv', 'a'), hit('p-inv', 'b'), hit('p-main', 'c')];
    const rows = withContentRows([], hits as never, CORPUS, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chat.tabName).toBe('Investing');
  });

  it('excludes the chat you are typing in', () => {
    const rows = withContentRows([], [hit('p-inv')] as never, CORPUS, {
      excludeTabId: 'investing',
    });
    expect(rows).toEqual([]);
  });
});

describe('toMentionChats — the corpus', () => {
  const groups: WorkspaceTabs[] = [
    {
      id: 'w1',
      slug: 'personal',
      name: 'Personal',
      tabs: [
        {
          id: 't1',
          slug: 'a',
          name: 'Live one',
          layout: 'p1',
          icon: '📈',
          headline: 'what it is about',
          clock: { started_at: 1000 },
          last_activity_at: 50,
        },
        { id: 't2', slug: 'b', name: 'Cold one', layout: 'p2', done: true, spawned_by: 't1' },
      ] as never,
    },
  ];

  it('carries the server-computed done flag onto the row', () => {
    expect(toMentionChats(groups).map((c) => [c.tabName, c.done ?? false])).toEqual([
      ['Live one', false],
      ['Cold one', true],
    ]);
  });

  it('builds the chip material once, off the SERVER clock — not last activity', () => {
    // The whole point of the migration decision: a clock that started at boot
    // must not be re-derived from a months-old last_activity_at.
    const [live, cold] = toMentionChats(groups);
    expect(live?.chip).toMatchObject({
      name: 'Live one',
      icon: '📈',
      headline: 'what it is about',
      clock_started_at: 1000,
    });
    expect(cold?.chip).toMatchObject({ done: true, spawned_by: 't1' });
  });
});
