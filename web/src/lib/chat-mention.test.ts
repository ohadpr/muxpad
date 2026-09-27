// The `@` mention grammar. Pure functions, tested directly: the three readings
// of a mention (reference / direction / search) are one parse, and the bugs that
// matter are "it sent work to the wrong chat" and "the picker hovered over my
// whole sentence" — neither of which a rendered assertion would name.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  MENTION_QUERY_MAX,
  MENTION_SEARCH_MAX,
  MENTION_SEARCH_PAGE,
  type MentionChat,
  type MentionPick,
  NO_MENTION_SEARCH,
  applyMention,
  canExpandSpawn,
  detectMentionRun,
  hitsFor,
  interleaveSpawnCards,
  liveSpawnedChildren,
  nextMentionRun,
  nextSearchLimit,
  parseDirectMarker,
  parseDirective,
  parseMentions,
  parseReportMarker,
  rankMentions,
  renderDirectMarker,
  renderReportMarker,
  repinPicks,
  runIsSettled,
  spawnCards,
  spawnReportSummary,
  spawnState,
  spawnedChildren,
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

  it('records WHICH chat was picked, by id, anchored at its @', () => {
    // The identity half. The draft still reads as the user's own words; the id
    // rides alongside so send time does not have to guess the name back.
    const run = detectMentionRun('@ma', 3);
    if (!run) throw new Error('expected a run');
    const next = applyMention('@ma', run, CORPUS[1] as MentionChat);
    expect(next.text).toBe('@Main ');
    expect(next.pick).toEqual({ tabId: 'main', name: 'Main', start: 0 });
  });
});

/**
 * PICKING A CHAT DECIDES WHICH CHAT GETS THE WORK.
 *
 * Both cases below were reproduced against the real functions before this
 * existed: the picker serialised the NAME and threw the selection away, and
 * `parseDirective` then re-resolved the name over the whole corpus. The user
 * chose a chat, watched the picker display the parent that distinguishes it, and
 * the work went somewhere else.
 */
describe('an explicit pick decides the recipient', () => {
  /** What the composer does: pick from the picker, then type the request. */
  const pickThenType = (draft: string, caret: number, chat: MentionChat, rest: string) => {
    const run = detectMentionRun(draft, caret);
    if (!run) throw new Error('expected a run');
    const applied = applyMention(draft, run, chat);
    const text = applied.text + rest;
    return { text, picks: repinPicks(text, [applied.pick]) };
  };

  it('sends to Main, not Main repo, when Main is what was picked', () => {
    // THE live case, and it needs no duplicate names at all: pick `Main`, type
    // `repo status`, and the draft reads `@Main repo status`.
    const { text, picks } = pickThenType('@ma', 3, CORPUS[1] as MentionChat, 'repo status');
    expect(text).toBe('@Main repo status');
    // The defect, still the answer without the pick — the longest name wins and
    // it is a different chat with a truncated request.
    expect(parseDirective(text, CORPUS)).toMatchObject({
      target: { tabName: 'Main repo' },
      body: 'status',
    });
    // With it, the chat the user chose, and the whole request.
    expect(parseDirective(text, CORPUS, picks)).toMatchObject({
      target: { tabName: 'Main' },
      body: 'repo status',
    });
  });

  it('sends to the same-named chat that was actually selected', () => {
    // Names are not unique and nothing enforces it. The picker shows the parent
    // to tell two `Work review` rows apart, so the distinction is visible at the
    // moment of choosing and must not be lost by choosing.
    const first = chat({ tabName: 'Work review', tabId: 'wr-1', parentName: 'Main' });
    const second = chat({ tabName: 'Work review', tabId: 'wr-2', parentName: 'Investing' });
    const corpus = [first, second];
    const { text, picks } = pickThenType('@work', 5, second, 'check it');
    expect(text).toBe('@Work review check it');
    expect(parseDirective(text, corpus, picks)?.target.tabId).toBe('wr-2');
    // …and picking the other one sends to the other one. Without the picks both
    // go to whichever the sort happens to put first.
    const other = pickThenType('@work', 5, first, 'check it');
    expect(parseDirective(other.text, corpus, other.picks)?.target.tabId).toBe('wr-1');
  });

  it('still gets the work to a chat RENAMED after it was picked', () => {
    // The token in the draft is the old name; the pick is an id. Identity wins,
    // and the body still starts after the token the user can see.
    const { text, picks } = pickThenType('@ma', 3, CORPUS[1] as MentionChat, 'run it');
    const renamed = [chat({ tabName: 'Mainline', tabId: 'main' })];
    expect(parseDirective(text, renamed, picks)).toMatchObject({
      target: { tabId: 'main' },
      body: 'run it',
    });
  });

  it('falls back to the name when the pick does not describe this draft', () => {
    // A pick anchored somewhere else, or at a token that has been edited away,
    // must not hijack the leading mention. The fallback is the old behaviour,
    // which is right for text typed by hand.
    const stray: MentionPick[] = [{ tabId: 'investing', name: 'Investing', start: 40 }];
    expect(parseDirective('@Main repo run it', CORPUS, stray)?.target.tabName).toBe('Main repo');
  });

  it('ignores a pick for a chat that is no longer in the corpus', () => {
    const gone: MentionPick[] = [{ tabId: 'deleted', name: 'Main', start: 0 }];
    // Resolution continues rather than failing: the name still reads as a chat.
    expect(parseDirective('@Main repo run it', CORPUS, gone)?.target.tabName).toBe('Main repo');
  });

  it('resolves the same way whatever order the corpus is in', () => {
    // The sidebar's order moves with activity, and it used to be the tie-break
    // between two same-named chats — so an already-written mention changed
    // destination through the day.
    const a = chat({ tabName: 'Work review', tabId: 'wr-1' });
    const b = chat({ tabName: 'Work review', tabId: 'wr-2' });
    expect(parseDirective('@Work review go', [a, b])?.target.tabId).toBe(
      parseDirective('@Work review go', [b, a])?.target.tabId,
    );
  });
});

describe('repinPicks — a pick survives editing, or it is dropped', () => {
  const pick = (over: Partial<MentionPick> = {}): MentionPick => ({
    tabId: 'main',
    name: 'Main',
    start: 0,
    ...over,
  });

  it('follows the token when text is typed in front of it', () => {
    expect(repinPicks('hey @Main go', [pick()])).toEqual([pick({ start: 4 })]);
  });

  it('drops a pick whose token the user deleted', () => {
    expect(repinPicks('go and do it', [pick()])).toEqual([]);
    // Half-deleted counts as deleted: `@Mai` is not the token that was inserted.
    expect(repinPicks('@Mai go', [pick()])).toEqual([]);
  });

  it('keeps a pick that has not moved, and never lets another steal its anchor', () => {
    // Two same-named chats, both mentioned. The one that is still where it was
    // claims that position first, so the second cannot slide onto it and change
    // who the first mention means.
    const held = pick({ tabId: 'wr-1', name: 'Work review', start: 0 });
    const later = pick({ tabId: 'wr-2', name: 'Work review', start: 14 });
    const text = '@Work review @Work review';
    expect(repinPicks(text, [later, held])).toEqual([
      held,
      pick({ tabId: 'wr-2', name: 'Work review', start: 13 }),
    ]);
  });

  it('does not match a token that is only a prefix of a longer word', () => {
    expect(repinPicks('@Mainframe go', [pick()])).toEqual([]);
  });

  it('is empty-safe both ways', () => {
    expect(repinPicks('', [pick()])).toEqual([]);
    expect(repinPicks('@Main go', [])).toEqual([]);
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
    expect(text).toContain("muxpad agent send 'pane-1'");
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

  /**
   * THE COMMAND IN THE INSTRUCTION IS A SHELL COMMAND, and this file is
   * otherwise about XML. `esc` escapes XML attribute characters and leaves the
   * apostrophe — right for a `"…"` attribute, wrong at the boundary where those
   * same attributes get interpolated into a `'…'` shell word. An ordinary
   * possessive in a chat name therefore ended the quote in the middle of the
   * ready-to-copy command, and whether the round trip happened at all came down
   * to the receiving agent noticing and repairing our own template.
   *
   * Checked against a REAL SHELL, because "is this valid sh" is not a claim a
   * regex should be making. `sh -n` for syntax; then `sh` with `muxpad` stubbed
   * out, so what the command would actually have DELIVERED is what gets parsed
   * back — the round trip, not a lookalike.
   */
  describe('the report-back command survives the names people give chats', () => {
    /** The two indented command lines, as an agent would copy them. */
    const commandOf = (instruction: string): string => {
      const lines = instruction.split('\n');
      const first = lines.findIndex((l) => l.trim().startsWith('muxpad agent send'));
      expect(first).toBeGreaterThanOrEqual(0);
      // The argument spans the marker line and the sentences line under it.
      return lines
        .slice(first, first + 2)
        .map((l) => l.trim())
        .join('\n');
    };

    const instruction = (to: string) =>
      renderDirectMarker({ id: 'd1', from: 'muxpad', pane: 'pane-1', to, toPane: 'pane-2' }, 'go');

    it.each(["Ohad's project", "it's a 'quoted' name", 'say "hi" <b> & co', "don't; rm -rf /"])(
      'is valid sh for a chat called %s',
      (name) => {
        const script = commandOf(instruction(name));
        const check = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
        expect({ name, status: check.status, err: check.stderr.trim() }).toEqual({
          name,
          status: 0,
          err: '',
        });
      },
    );

    it('delivers the marker VERBATIM through the shell, name and all', () => {
      // Runs the real command with the real quoting and a stub in muxpad's
      // place, then parses what arrived. Nothing in the chain is simulated
      // except the CLI itself.
      const name = "Ohad's project";
      const script = `muxpad() { printf '%s' "$4"; }\n${commandOf(instruction(name))}`;
      const run = spawnSync('/bin/sh', [], { input: script, encoding: 'utf8' });
      expect(run.status).toBe(0);
      const parsed = parseReportMarker(run.stdout);
      expect(parsed?.marker).toEqual({ id: 'd1', from: name, pane: 'pane-2' });
      // …and the agent's own line is the body, which is what draws the card.
      expect(parsed?.body).toContain('two or three sentences');
    });

    it('does not pretend the agent’s OWN prose is quoted for it', () => {
      // The half that cannot be fixed from here: the sentences are written by
      // the other agent, and "it's done" ends the quote exactly as a name did.
      // The instruction says so, and says the marker — not the command — is the
      // contract. Silence here would be the same bug wearing a fix.
      const text = instruction('Investing');
      expect(text).toContain("'\\''");
      expect(text).toContain('FIRST LINE is exactly the marker');
    });
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
      // a chat you walked away from sinks below every live one, even though it
      // is the most recently active of them
      'quarterly budget notes',
    ]);
  });

  it('does NOT sink a sub-chat that just delivered — it is a result, not neglect', () => {
    // The amendment's own case: a sub-chat leaves the live list the instant it
    // reports, so if `done` buried it under thirty live rows, the thing that
    // just came back would be the hardest row in the list to reach.
    const delivered = chat({
      tabName: 'Work review',
      done: true,
      doneReason: 'delivered',
      lastActivityAt: 500,
    });
    const rows = rankMentions([...CORPUS, delivered], '', {});
    expect(rows[0]?.chat.tabName).toBe('Work review');
    // …while decayed and archived still sort under the live chats.
    expect(rows.at(-1)?.chat.tabName).toBe('quarterly budget notes');
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

  it('finds a retired sub-chat that has no panes left', () => {
    // A delivered sub-chat may end up with no panes at all (nothing is deleted,
    // but nothing keeps a process either). Name and headline matching must not
    // depend on a pane existing — this list is one of the two ways back to it.
    const gone = chat({
      tabName: 'Credit failover',
      headline: 'why the billing retry gave up',
      done: true,
      doneReason: 'delivered',
      paneIds: [],
    });
    expect(rankMentions([gone], 'failover', {})[0]?.chat.tabName).toBe('Credit failover');
    expect(rankMentions([gone], 'billing retry', {})[0]?.chat.tabName).toBe('Credit failover');
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

describe('hitsFor — a result never outlives the query it answers', () => {
  const state = { query: 'cash', limit: 50, hits: [{ sid: 's1' }] as never };

  it('hands back the hits for their own query', () => {
    expect(hitsFor(state, 'cash')).toHaveLength(1);
    expect(hitsFor(state, ' cash ')).toHaveLength(1);
  });

  it('hands back NOTHING under a different query', () => {
    // The defect: search `@cash`, take a hit, retype the query as `@zebra`, and
    // the cash row stayed in the open picker — header saying zebra, row selected,
    // Enter picking an unrelated chat — for the debounce plus a round trip. The
    // ticket scheme cannot help: it guards a late RESPONSE, not stale state.
    expect(hitsFor(state, 'zebra')).toEqual([]);
    expect(hitsFor(state, '')).toEqual([]);
    expect(hitsFor(NO_MENTION_SEARCH, 'cash')).toEqual([]);
  });
});

describe('nextSearchLimit — how far the content tier goes, and when it stops', () => {
  const ask = (over: Partial<Parameters<typeof nextSearchLimit>[0]> = {}) =>
    nextSearchLimit({
      query: 'trayo',
      state: NO_MENTION_SEARCH,
      rows: 0,
      want: 8,
      archiveAvailable: true,
      ...over,
    });

  it('asks for the first page for a new query', () => {
    expect(ask()).toBe(MENTION_SEARCH_PAGE);
  });

  it('asks nothing of an archive that is not there, or of a query too short', () => {
    expect(ask({ archiveAvailable: false })).toBeNull();
    expect(ask({ query: 'ab' })).toBeNull();
    expect(ask({ query: '' })).toBeNull();
    expect(ask({ query: 'x'.repeat(257) })).toBeNull();
  });

  it('goes back for the big page when a FULL page did not fill the picker', () => {
    // The real shape of the defect: the archive returns 50 hits, 47 of them in
    // sessions whose panes are no longer chats, so the picker renders one row
    // with seven slots free and no way to ask for more.
    const state = { query: 'trayo', limit: 50, hits: Array.from({ length: 50 }) as never };
    expect(ask({ state, rows: 1 })).toBe(MENTION_SEARCH_MAX);
  });

  it('stops once the picker is full — a full list is not worth another request', () => {
    const state = { query: 'trayo', limit: 50, hits: Array.from({ length: 50 }) as never };
    expect(ask({ state, rows: 8 })).toBeNull();
  });

  it('stops when the page came back SHORT — the archive has no more to give', () => {
    // Asking for more of nothing is a round trip that cannot change the answer.
    const state = { query: 'trayo', limit: 50, hits: Array.from({ length: 12 }) as never };
    expect(ask({ state, rows: 1 })).toBeNull();
  });

  it('stops at the server’s own cap, and does not loop', () => {
    // MENTION_SEARCH_MAX is routes/search.ts's clamp, so there is nothing past
    // it to ask for. Without this the escalation would re-fire forever on a
    // query whose hits never resolve.
    const state = {
      query: 'trayo',
      limit: MENTION_SEARCH_MAX,
      hits: Array.from({ length: MENTION_SEARCH_MAX }) as never,
    };
    expect(ask({ state, rows: 0 })).toBeNull();
  });

  it('starts over for a new query even mid-escalation', () => {
    const state = { query: 'trayo', limit: 50, hits: Array.from({ length: 50 }) as never };
    expect(ask({ state, query: 'codex', rows: 0 })).toBe(MENTION_SEARCH_PAGE);
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
          clock: { started_at: 1000, expires_at: 5000, fill: 0.5, last_day: false, stopped: false },
          last_activity_at: 50,
        },
        { id: 't2', slug: 'b', name: 'Cold one', layout: 'p2', done: true, spawned_by: 't1' },
        {
          id: 't3',
          slug: 'c',
          name: 'Work review',
          // Retired on delivery: no panes, no clock, and a parent.
          layout: '',
          done: true,
          done_reason: 'delivered',
          spawned_by: 't1',
          clock: null,
          last_activity_at: 9_000,
          created_at: 7_000,
          spawn_report: 'Reviewed the branch and found two failing tests.',
          spawn_report_at: 9_500,
          spawn_report_state: 'ok',
        },
      ] as never,
    },
  ];

  it('carries the server-computed done flag onto the row', () => {
    expect(toMentionChats(groups).map((c) => [c.tabName, c.done ?? false])).toEqual([
      ['Live one', false],
      ['Cold one', true],
      ['Work review', true],
    ]);
  });

  it('builds the chip material once, and passes the SERVER clock through whole', () => {
    // Not a start timestamp the client re-derives a phase from: the server
    // computed `fill` and `last_day`, and the chip only quantises the fill.
    const [live, cold] = toMentionChats(groups);
    expect(live?.chip).toMatchObject({
      name: 'Live one',
      icon: '📈',
      headline: 'what it is about',
      clock: { started_at: 1000, fill: 0.5, last_day: false, stopped: false },
    });
    expect(cold?.chip).toMatchObject({ done: true, spawned_by: 't1' });
  });

  it('does not invent a clock for a sub-chat the server says has none', () => {
    // `clock: null` is "there is no clock", not "the clock is at 0", and the
    // chip draws a clean tile for it. (B's chip no longer accepts a timestamp
    // at all, so there is no longer a fallback for this to fall through TO —
    // the assertion that it did not is gone with the field.)
    const sub = toMentionChats(groups)[2];
    expect(sub?.chip.clock).toBeUndefined();
  });

  it('resolves the parent to a NAME, and keeps the reason it is done', () => {
    const sub = toMentionChats(groups)[2];
    expect(sub?.parentName).toBe('Live one');
    expect(sub?.doneReason).toBe('delivered');
    // A child whose parent row carries no reason gets none invented for it.
    expect(toMentionChats(groups)[1]?.doneReason).toBeUndefined();
  });

  it('keeps the parent ID too — the card in the parent is asked the other way round', () => {
    expect(toMentionChats(groups).map((c) => c.parentId)).toEqual([undefined, 't1', 't1']);
  });

  it('carries the SPAWN REPORT off the row, as one object or not at all', () => {
    // The three columns arrive as a set and are read as a set: a state with no
    // timestamp has no place in the log to sit, and publishing the timestamp
    // alone would put an empty entry in the conversation.
    expect(toMentionChats(groups)[2]?.report).toEqual({
      text: 'Reviewed the branch and found two failing tests.',
      state: 'ok',
      at: 9_500,
    });
    expect(toMentionChats(groups)[0]?.report).toBeUndefined();
  });

  it('reads a report field without its pair as NO report', () => {
    const reported = (groups[0] as { tabs: Record<string, unknown>[] }).tabs[2];
    const half = [
      { ...groups[0], tabs: [{ ...reported, spawn_report_at: null }] },
    ] as never as WorkspaceTabs[];
    expect(toMentionChats(half)[0]?.report).toBeUndefined();
  });

  it('carries created_at — for a child, that IS the moment of the spawn', () => {
    // The anchor for the card in the parent's log. Server-side, durable,
    // cross-device, and already on the row: no new storage was needed for it.
    expect(toMentionChats(groups).map((c) => c.createdAt)).toEqual([undefined, undefined, 7_000]);
  });
});

/**
 * WHAT THIS CHAT SPAWNED — the cards IN its log, and the count above its
 * composer.
 *
 * Derived from the corpus rather than stored: a child chat IS the record that a
 * spawn happened, so a spawn made by the CLI (an agent delegating work) shows up
 * in the parent conversation on every device, which a device-local echo could
 * never do.
 */
describe('spawnedChildren', () => {
  const kid = (name: string, over: Partial<MentionChat> = {}) =>
    chat({ tabName: name, parentId: 'p', ...over });

  it('is empty for a chat that has spawned nothing, and for no chat at all', () => {
    expect(spawnedChildren(CORPUS, 'p')).toEqual([]);
    expect(spawnedChildren([kid('a')], undefined)).toEqual([]);
  });

  it('takes only DIRECT children', () => {
    const rows = [kid('a'), chat({ tabName: 'grandkid', parentId: 'a' })];
    expect(spawnedChildren(rows, 'p').map((c) => c.tabName)).toEqual(['a']);
  });

  it('ignores a row that names itself as its own parent', () => {
    expect(spawnedChildren([chat({ tabName: 'loop', tabId: 'p', parentId: 'p' })], 'p')).toEqual(
      [],
    );
  });

  it('is ordered by WHEN IT WAS SPAWNED, so a new spawn comes last', () => {
    const rows = [
      kid('third', { createdAt: 300 }),
      kid('first', { createdAt: 100 }),
      kid('second', { createdAt: 200 }),
    ];
    expect(spawnedChildren(rows, 'p').map((c) => c.tabName)).toEqual(['first', 'second', 'third']);
  });

  it('does NOT reorder when a child says something — a card is anchored to the spawn', () => {
    // The whole point of the amendment. The cards are transcript entries now, so
    // an entry that walks up and down the log every time the busiest child
    // speaks is a message that moves while you read it. Ordering on
    // `lastActivityAt` — which is what this did while the cards were pinned
    // furniture — puts `first` last here.
    const rows = [
      kid('first', { createdAt: 100, lastActivityAt: 9_000 }),
      kid('second', { createdAt: 200, lastActivityAt: 150 }),
    ];
    expect(spawnedChildren(rows, 'p').map((c) => c.tabName)).toEqual(['first', 'second']);
  });

  it('puts a row with no creation time at the FRONT, not at "now"', () => {
    // Unreachable against a real server (`created_at` is non-optional on the
    // row); what matters is that the fallback is a STABLE place rather than one
    // that moves on every render.
    const rows = [kid('dated', { createdAt: 100 }), kid('undated')];
    expect(spawnedChildren(rows, 'p').map((c) => c.tabName)).toEqual(['undated', 'dated']);
  });

  it('orders TOTALLY, so two rows cannot swap places between renders', () => {
    const rows = [
      chat({ tabName: 'b', tabId: 'b', parentId: 'p' }),
      chat({ tabName: 'a', tabId: 'a', parentId: 'p' }),
    ];
    expect(spawnedChildren(rows, 'p').map((c) => c.tabId)).toEqual(['a', 'b']);
  });

  it('sheds DELIVERED children at the cap and never a live one', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        chat({
          tabName: `done-${i}`,
          tabId: `d${i}`,
          parentId: 'p',
          done: true,
          createdAt: i,
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        chat({ tabName: `live-${i}`, tabId: `l${i}`, parentId: 'p', createdAt: 100 + i }),
      ),
    ];
    const kept = spawnedChildren(rows, 'p', 4).map((c) => c.tabId);
    // Every live child, plus the most recent result — the oldest results go.
    expect(kept).toEqual(['d4', 'l0', 'l1', 'l2']);
  });

  it('keeps every live child even when they alone exceed the cap', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      chat({ tabName: `live-${i}`, tabId: `l${i}`, parentId: 'p', createdAt: i }),
    );
    expect(spawnedChildren(rows, 'p', 2)).toHaveLength(5);
  });

  it('liveSpawnedChildren is the running ones, uncapped — it is a COUNT', () => {
    const rows = [
      kid('working', { tabId: 'w' }),
      kid('delivered', { tabId: 'd', done: true, doneReason: 'delivered' }),
    ];
    expect(liveSpawnedChildren(rows, 'p').map((c) => c.tabId)).toEqual(['w']);
  });
});

/**
 * THE CARDS AND THE COUNT CANNOT DISAGREE.
 *
 * `spawnCards` is what the conversation draws; `liveSpawnedChildren` is the
 * number above the composer and the status cell's roster. They were two lists
 * once, which is how the log came to show six finished agents while the roster
 * said nothing was running. The cards now KEEP the finished ones — a card is an
 * entry at the moment of the spawn, not furniture that has to justify itself
 * forever — so the agreement that matters is narrower and must be stated: the
 * cards that say WORKING are exactly the children the roster counts.
 */
describe('spawnCards', () => {
  const rows = [
    chat({ tabName: 'first', tabId: 'a', parentId: 'p', createdAt: 100 }),
    chat({
      tabName: 'second',
      tabId: 'b',
      parentId: 'p',
      createdAt: 200,
      done: true,
      doneReason: 'delivered',
    }),
    chat({ tabName: 'third', tabId: 'c', parentId: 'p', createdAt: 300 }),
  ];

  it('carries the spawn MOMENT with each card — that is what places it', () => {
    expect(spawnCards(rows, 'p')).toEqual([
      { chat: rows[0], kind: 'launch', at: 100 },
      { chat: rows[1], kind: 'launch', at: 200 },
      { chat: rows[2], kind: 'launch', at: 300 },
    ]);
  });

  it('KEEPS a delivered child, which the foot-of-log list could not', () => {
    // Pinned above the composer this was clutter forever; in the log it is the
    // record that this chat started something and it finished, and it scrolls
    // away like any other message.
    expect(spawnCards(rows, 'p').map((c) => c.chat.tabId)).toContain('b');
  });

  it('agrees with the roster about what is RUNNING, exactly', () => {
    const working = spawnCards(rows, 'p')
      .filter((c) => !c.chat.done)
      .map((c) => c.chat.tabId);
    expect(working).toEqual(liveSpawnedChildren(rows, 'p').map((c) => c.tabId));
  });

  it('agrees with the roster even past the cap, where cards are shed', () => {
    // The cap sheds FINISHED cards only, so no amount of shedding can make the
    // card list and the running count disagree.
    const many = [
      ...Array.from({ length: 30 }, (_, i) =>
        chat({ tabName: `d${i}`, tabId: `d${i}`, parentId: 'p', done: true, createdAt: i }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        chat({ tabName: `l${i}`, tabId: `l${i}`, parentId: 'p', createdAt: 1_000 + i }),
      ),
    ];
    const working = spawnCards(many, 'p')
      .filter((c) => !c.chat.done)
      .map((c) => c.chat.tabId);
    expect(working).toEqual(liveSpawnedChildren(many, 'p').map((c) => c.tabId));
    expect(working).toHaveLength(20);
  });
});

/**
 * THE REPORT — the entry that did not exist.
 *
 * "i don't see the summary of the work of this card anywhere — not in the main
 * muxpad chat, not when hovering over the card, not in some other expandable
 * toggle thing in the card". The summary is written server-side off the child's
 * own transcript; this is the half that decides WHERE it appears and WHAT the
 * card says about it.
 */
describe('spawnCards — TWO entries per child: the launch, then the completion', () => {
  const kid = (over: Partial<MentionChat> = {}) =>
    chat({ tabName: 'dead-css', tabId: 'dc', parentId: 'p', createdAt: 100, ...over });

  const finished = (over: Partial<MentionChat> = {}) =>
    kid({ done: true, doneReason: 'delivered', doneAt: 9_000, ...over });

  it('a RUNNING child has only its launch card', () => {
    // Nothing appears at the bottom until it actually finishes.
    expect(spawnCards([kid()], 'p')).toEqual([{ chat: kid(), kind: 'launch', at: 100 }]);
  });

  it('A FINISHED CHILD ADDS A SECOND ENTRY, where it FINISHED', () => {
    // "if the chat has progressed then it doesn't help much to update the
    // original card … when the sub-chat is done we should add another card
    // marking its completion with the summary etc, and that card should be added
    // at the bottom of the chat so the user will see it."
    //
    // A card that mutates in place is invisible once the conversation has
    // scrolled past it — which is exactly when a long job finishes.
    expect(spawnCards([finished()], 'p')).toEqual([
      { chat: finished(), kind: 'launch', at: 100 },
      { chat: finished(), kind: 'completion', at: 9_000 },
    ]);
  });

  it('draws BOTH back to back when nothing happened in between', () => {
    // Explicitly fine, and explicitly not to be suppressed, collapsed or merged.
    const quick = finished({ createdAt: 500, doneAt: 501 });
    expect(spawnCards([quick], 'p').map((c) => [c.kind, c.at])).toEqual([
      ['launch', 500],
      ['completion', 501],
    ]);
  });

  it('IS STABLE — the same two places on every render', () => {
    // Neither entry moves once placed, and a reload puts them back in the same
    // two spots: both times are server-stamped columns, and nothing here reads
    // a clock or an activity bump.
    const rows = [finished(), kid({ tabId: 'other', createdAt: 3_000 })];
    const once = spawnCards(rows, 'p');
    const twice = spawnCards(rows, 'p');
    expect(twice).toEqual(once);
    expect(once.map((c) => [c.chat.tabId, c.kind, c.at])).toEqual([
      ['dc', 'launch', 100],
      ['other', 'launch', 3_000],
      ['dc', 'completion', 9_000],
    ]);
  });

  it('a child that finished BEFORE this shipped lands back in old history', () => {
    // Correct and consistent: its completion is a fact about a moment, and that
    // moment was hours ago. Not special-cased to the foot of the log.
    const old = finished({ createdAt: 10, doneAt: 20 });
    const recent = kid({ tabId: 'now', createdAt: 8_000 });
    expect(spawnCards([old, recent], 'p').map((c) => c.at)).toEqual([10, 20, 8_000]);
  });

  it('falls back through the timestamps it has, and draws nothing with none', () => {
    // `done_at` is the truth. A CRASHED worker never retires, so it has none —
    // its report's stamp is the only "when" that exists for it. `lastActivityAt`
    // is the last resort: a finished child on a server that predates `done_at`
    // still gets a completion card rather than silently losing one.
    const crashed = kid({
      report: { text: 'died half way', state: 'crashed', at: 4_000 },
      lastActivityAt: 7_777,
    });
    expect(spawnCards([crashed], 'p').map((c) => [c.kind, c.at])).toEqual([
      ['launch', 100],
      ['completion', 4_000],
    ]);
    const older = finished({ doneAt: undefined, lastActivityAt: 6_000 });
    expect(spawnCards([older], 'p').map((c) => [c.kind, c.at])).toEqual([
      ['launch', 100],
      ['completion', 6_000],
    ]);
    const timeless = finished({ doneAt: undefined, lastActivityAt: undefined });
    expect(spawnCards([timeless], 'p').map((c) => c.kind)).toEqual(['launch']);
  });

  it("sheds a child's TWO entries together when the cap bites", () => {
    // Half a pair is worse than neither: a launch whose completion is missing
    // reads as work that vanished, and a completion with no launch as one that
    // came from nowhere.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        finished({ tabId: `r${i}`, createdAt: i, doneAt: 500 + i }),
      ),
      kid({ tabId: 'live', createdAt: 900 }),
    ];
    const ids = spawnCards(rows, 'p', 2).map((c) => c.chat.tabId);
    expect(ids.filter((id) => id === 'r3')).toHaveLength(2);
    expect(ids).not.toContain('r0');
  });

  it('a completion does not make a finished child count as running', () => {
    expect(liveSpawnedChildren([finished()], 'p')).toEqual([]);
  });
});

/**
 * WHAT A COMPLETION CARD IS ALLOWED TO CLAIM.
 *
 * Three report states exist in the wild at once and they are not
 * interchangeable — measured on the real database: `ok` (a summary), `none` (it
 * finished having produced nothing, and said so), and UNSET (the generation was
 * attempted and came back unusable; `spawn_report_at` is stamped and
 * `spawn_report_state` is NULL). A card must not promise something behind a
 * control for the last two.
 */
describe('canExpandSpawn — an expander only where there is a result behind it', () => {
  const withState = (state: 'ok' | 'none' | 'crashed' | null) =>
    chat({
      tabName: 'kid',
      tabId: 'k',
      done: true,
      doneReason: 'delivered',
      ...(state ? { report: { text: state === 'ok' ? 'found 2' : null, state, at: 5 } } : {}),
    });

  it('offers it for a real report', () => {
    expect(canExpandSpawn(withState('ok'))).toBe(true);
  });

  it('REFUSES IT when the generator said there was nothing', () => {
    // The card says "Finished with nothing to report." A control under that
    // sentence promises a second opinion that does not exist.
    expect(canExpandSpawn(withState('none'))).toBe(false);
  });

  it('REFUSES IT when there is no report at all', () => {
    // The case that produced the complaint: with nothing to show, the expander
    // fell through to the transcript and dumped the worker's entire narration.
    // Better to offer nothing than to offer the story of how it worked.
    expect(canExpandSpawn(withState(null))).toBe(false);
  });

  it('offers it for a crashed worker — what it got done before dying IS the result', () => {
    expect(canExpandSpawn(withState('crashed'))).toBe(true);
  });
});

/**
 * A WORKER THAT IS WORKING IS NOT FINISHED, whatever its row says.
 *
 * Measured on the real database: `sidebar-slack` carries `retired_at` with
 * reason `delivered` — the server retired it at a turn end, correctly — while
 * the user is still working in it. Its card wore a green tick. Retirement is a
 * statement about a DELIVERY; the pane's live status is a statement about right
 * now, and right now outranks it.
 */
describe('spawnState — the live status outranks a stale retirement', () => {
  const retired = (over: Partial<MentionChat> = {}) =>
    chat({ tabName: 'sidebar-slack', tabId: 'ss', done: true, doneReason: 'delivered', ...over });

  it('is WORKING while its pane is working, even though the row says delivered', () => {
    expect(spawnState(retired({ status: 'working' }))).toBe('working');
  });

  it('is delivered again the moment it goes quiet', () => {
    expect(spawnState(retired({ status: 'idle' }))).toBe('delivered');
    expect(spawnState(retired())).toBe('delivered');
  });

  it('and draws NO completion entry while it is working', () => {
    // Nothing arrives at the bottom of the conversation for work that is still
    // going on — which is the whole rule the two-card split rests on.
    const busy = retired({ parentId: 'p', createdAt: 100, doneAt: 900, status: 'working' });
    expect(spawnCards([busy], 'p').map((c) => c.kind)).toEqual(['launch']);
  });
});

describe('spawnReportSummary — what the card says when there are no sentences', () => {
  it('says it plainly, and invents nothing', () => {
    // "A child that produced nothing useful says so plainly. Do not invent a
    // summary for it."
    expect(spawnReportSummary({ text: null, state: 'none', at: 1 })).toBe(
      'Finished with nothing to report.',
    );
    expect(spawnReportSummary({ text: null, state: 'crashed', at: 1 })).toBe(
      'Crashed before it produced anything.',
    );
  });

  it('prefers the real report over either', () => {
    expect(spawnReportSummary({ text: 'Read 14 pages.', state: 'crashed', at: 1 })).toBe(
      'Read 14 pages.',
    );
  });
});

/**
 * WHAT THE CARD SAYS HAPPENED.
 *
 * `delivered` used to be the only word, rendered as mono grey text, and `failed`
 * did not exist at all — which was not a wording problem: a crashed worker KEEPS
 * its live row on purpose, so the card read it as still working and span forever.
 */
describe('spawnState', () => {
  const kidAt = (over: Partial<MentionChat>) => chat({ tabName: 'kid', tabId: 'k', ...over });

  it('is working while the chat is live', () => {
    expect(spawnState(kidAt({}))).toBe('working');
  });

  it('is delivered when the work landed', () => {
    expect(spawnState(kidAt({ done: true, doneReason: 'delivered' }))).toBe('delivered');
  });

  it('is done for a chat that left the live list any other way', () => {
    expect(spawnState(kidAt({ done: true, doneReason: 'archived' }))).toBe('done');
    expect(spawnState(kidAt({ done: true, doneReason: 'decayed' }))).toBe('done');
    expect(spawnState(kidAt({ done: true }))).toBe('done');
  });

  it('IS FAILED FOR A CRASHED WORKER, WHICH NEVER RETIRES', () => {
    // The one state that is not derived from the lifecycle, because the
    // lifecycle cannot see it: `done` is false and stays false.
    const crashed = kidAt({ report: { text: null, state: 'crashed', at: 5 } });
    expect(crashed.done).toBeUndefined();
    expect(spawnState(crashed)).toBe('failed');
  });

  it('lets the crash outrank a delivery — the last thing that happened wins', () => {
    const revived = kidAt({
      done: true,
      doneReason: 'delivered',
      report: { text: 'died half way', state: 'crashed', at: 5 },
    });
    expect(spawnState(revived)).toBe('failed');
  });
});

/**
 * WHERE A CARD SITS IN THE LOG.
 *
 * The user's spec: "when you launch them have that UI component in the chat as an
 * indication that u launched … don't glue it to the bottom." A spawn is not a
 * transcript line — the tool call that made the child is, but the child's row is
 * the record — so placement is a join on TIME between the transcript's entries
 * and the children's `created_at`. This is that join, and it is pure so the
 * ordering can be tested against real timestamps rather than by appending to a
 * turn and hoping.
 */
describe('interleaveSpawnCards', () => {
  const card = (id: string, at: number) => ({
    chat: chat({ tabName: id, tabId: id }),
    kind: 'launch' as const,
    at,
  });
  const shape = (out: ReturnType<typeof interleaveSpawnCards<string>>) =>
    out.map((x) => (x.kind === 'card' ? `[${x.card.chat.tabId}]` : x.node));

  const entries = [
    { at: 100, node: 'msg-1' },
    { at: 200, node: 'msg-2' },
    { at: 300, node: 'msg-3' },
  ];

  it('places a card between the messages that bracket the spawn', () => {
    expect(shape(interleaveSpawnCards(entries, [card('kid', 250)]))).toEqual([
      'msg-1',
      'msg-2',
      '[kid]',
      'msg-3',
    ]);
  });

  it('a spawn that just happened lands at the bottom — and only there', () => {
    expect(shape(interleaveSpawnCards(entries, [card('kid', 9_000)]))).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
      '[kid]',
    ]);
  });

  it('a spawn older than the loaded history lands at the top', () => {
    // Its turn is further back than the window reaches, and the top is where
    // "further back" is. Loading older messages moves it into its own slot —
    // which is the same join, not a card drifting.
    expect(shape(interleaveSpawnCards(entries, [card('kid', 1)]))).toEqual([
      '[kid]',
      'msg-1',
      'msg-2',
      'msg-3',
    ]);
  });

  it('keeps several spawns in spawn order, each in its own slot', () => {
    const out = interleaveSpawnCards(entries, [card('a', 150), card('b', 160), card('c', 250)]);
    expect(shape(out)).toEqual(['msg-1', '[a]', '[b]', 'msg-2', '[c]', 'msg-3']);
  });

  it('does not move a card when the child changes — only when the LOG does', () => {
    // The indicator has to keep updating in place after the card has scrolled
    // up: same `at`, new `done`, same slot.
    const working = card('kid', 250);
    const finished = { ...working, chat: { ...working.chat, done: true } };
    const at = (c: typeof working) => shape(interleaveSpawnCards(entries, [c])).indexOf('[kid]');
    expect(at(finished)).toBe(at(working));
  });

  it("PLACES A CHILD'S TWO ENTRIES IN TWO DIFFERENT SLOTS, and keeps them there", () => {
    // The whole point of the pair, driven through the real join: the launch
    // lands next to the message that caused it and the completion lands next to
    // whatever the conversation had reached by the time the work ended — which
    // is where the reader is looking when a long job finishes.
    const child = chat({
      tabName: 'dead-css',
      tabId: 'dc',
      parentId: 'p',
      createdAt: 120,
      done: true,
      doneReason: 'delivered',
      doneAt: 280,
    });
    const place = () => shape(interleaveSpawnCards(entries, spawnCards([child], 'p')));
    expect(place()).toEqual(['msg-1', '[dc]', 'msg-2', '[dc]', 'msg-3']);
    // STABLE: the same two slots on a re-render, and on a reload — both times
    // are server-stamped columns, so nothing here can drift.
    expect(place()).toEqual(place());
  });

  it('is not placed by an entry with no timestamp — that is a guess', () => {
    // A transcript line with no parseable time cannot say whether the spawn came
    // before or after it, and guessing would put the card somewhere else on the
    // next reload.
    const mixed = [
      { at: null, node: 'undated' },
      { at: 300, node: 'msg-3' },
    ];
    expect(shape(interleaveSpawnCards(mixed, [card('kid', 250)]))).toEqual([
      'undated',
      '[kid]',
      'msg-3',
    ]);
  });

  it('is the entries themselves when there is nothing spawned', () => {
    expect(shape(interleaveSpawnCards(entries, []))).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('draws every card even when there are no entries at all', () => {
    expect(shape(interleaveSpawnCards([], [card('a', 1), card('b', 2)]))).toEqual(['[a]', '[b]']);
  });
});
