import { normalizeTranscriptLine, withMentionContext } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { LOOKUP_MAX_PANE_IDS } from './tab-lookup';
import {
  MAX_NAME_QUERIES,
  mentionTokens,
  onlyReferenced,
  parseContextRefs,
  transcriptRefs,
} from './transcript-mentions';

/** Built by the REAL writer, so a change to its wording breaks these, not prod. */
const sent = (chats: { name: string; tabId: string; paneIds: string[] }[]) =>
  withMentionContext('see these', chats);

describe('parseContextRefs — the handles a sent message carries', () => {
  it('reads name, tabId and every paneId, including a chat that had ended', () => {
    const text = sent([
      { name: 'Quarterly taxes', tabId: 't-old', paneIds: ['p1'] },
      { name: 'Two panes', tabId: 't-two', paneIds: ['p2', 'p3'] },
      { name: 'Ended — long ago', tabId: 't-end', paneIds: [] },
    ]);
    expect(parseContextRefs(text)).toEqual([
      { name: 'Quarterly taxes', tabId: 't-old', paneIds: ['p1'] },
      { name: 'Two panes', tabId: 't-two', paneIds: ['p2', 'p3'] },
      { name: 'Ended — long ago', tabId: 't-end', paneIds: [] },
    ]);
  });

  it('a message without a block, or with a block quoted mid-text, has none', () => {
    expect(parseContextRefs('plain words, @Someone')).toEqual([]);
    expect(parseContextRefs(`${sent([{ name: 'A', tabId: 't', paneIds: ['p'] }])}\nmore`)).toEqual(
      [],
    );
  });
});

const none = { tab: () => false, pane: () => false, fullLiveName: () => false };
const msgs = (...texts: string[]) => texts.map((text) => ({ text }));

describe('transcriptRefs — what one open transcript asks the lookup for', () => {
  it('REAL normalizer output: the stripped text has no block, the kept mentions are exact', () => {
    const [ev] = normalizeTranscriptLine({
      type: 'user',
      uuid: 'u1',
      timestamp: new Date(1).toISOString(),
      message: {
        role: 'user',
        content: sent([{ name: 'Quarterly taxes', tabId: 't-old', paneIds: ['p1'] }]),
      },
    });
    const user = ev as { kind: 'user'; text: string; mentions?: { tabId: string }[] };
    expect(user.text).not.toContain('muxpad-context');
    expect(parseContextRefs(user.text)).toEqual([]);
    expect(transcriptRefs({ messages: [user] }, none)).toEqual({
      tabIds: ['t-old'],
      paneIds: [],
      names: [],
    });
  });

  it('exact ids newest first, then senders and directed targets; one per chat; live skipped', () => {
    const messages = [
      { text: 'a', mentions: [{ tabId: 't-old' }] },
      {
        text: sent([
          { name: 'Live', tabId: 't-live', paneIds: ['p-live'] },
          { name: 'Ended', tabId: 't-end', paneIds: [] },
          { name: 'Old', tabId: 't-old', paneIds: ['p-old'] },
        ]),
      },
    ];
    expect(
      transcriptRefs(
        { messages, extraTabIds: ['t-sender', 't-old', 't-live', 't-directed'] },
        { ...none, tab: (id) => id === 't-live' },
      ),
    ).toEqual({ tabIds: ['t-end', 't-old', 't-sender', 't-directed'], paneIds: [], names: [] });
  });

  it('a marker contributes its PANE — the only handle it records', () => {
    const refs = transcriptRefs(
      {
        messages: msgs('<report p-a>', 'plain', '<report p-live>', '<report p-a>'),
        markerPane: (t) => /<report (\S+)>/.exec(t)?.[1] ?? null,
      },
      { ...none, pane: (p) => p === 'p-live' },
    );
    expect(refs.paneIds).toEqual(['p-a']);
  });

  it('FALLBACK: plain @tokens only where nothing exact was recorded; newest first; capped', () => {
    const refs = transcriptRefs(
      {
        messages: [
          ...msgs('old @alpha', '@beta, @gamma.', 'email me@example.com'),
          { text: '@exact', mentions: [{ tabId: 't-x' }] },
          ...msgs('@d1 @d2 @d3 @d4 @d5 @d6'),
        ],
      },
      none,
    );
    expect(refs.names).toHaveLength(MAX_NAME_QUERIES);
    expect(refs.names).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    // `me@example.com` is not a mention; punctuation is not part of a name.
    expect(
      transcriptRefs(
        { messages: msgs('old @alpha', '@beta, @gamma.', 'email me@example.com') },
        none,
      ).names,
    ).toEqual(['beta', 'gamma', 'alpha']);
    // A message with an exact record asks no name query of its own.
    expect(
      transcriptRefs({ messages: [{ text: '@exact', mentions: [{ tabId: 't' }] }] }, none).names,
    ).toEqual([]);
  });

  it('a query is skipped only when the message names a LIVE chat IN FULL', () => {
    const live = ['quarterly-plan'];
    const known = {
      ...none,
      fullLiveName: (token: string, lower: string) =>
        live.some((n) => n.startsWith(token) && lower.includes(`@${n}`)),
    };
    // Shares only a first word with the live chat → still asked.
    expect(transcriptRefs({ messages: msgs('@quarterly-taxes?') }, known).names).toEqual([
      'quarterly-taxes',
    ]);
    expect(transcriptRefs({ messages: msgs('see @Quarterly taxes') }, known).names).toEqual([
      'quarterly',
    ]);
    // The live chat, named in full → nothing to look up.
    expect(transcriptRefs({ messages: msgs('see @quarterly-plan') }, known).names).toEqual([]);
  });

  it(`bounded: at most ${LOOKUP_MAX_PANE_IDS} exact ids, newest kept`, () => {
    const messages = Array.from({ length: LOOKUP_MAX_PANE_IDS + 3 }, (_, i) => ({
      text: `m${i}`,
      mentions: [{ tabId: `t${i}` }],
    }));
    const refs = transcriptRefs({ messages, extraTabIds: ['late'] }, none);
    expect(refs.tabIds).toHaveLength(LOOKUP_MAX_PANE_IDS);
    expect(refs.tabIds).toContain(`t${LOOKUP_MAX_PANE_IDS + 2}`);
    expect(refs.tabIds).not.toContain('t0');
    expect(refs.tabIds).not.toContain('late');
  });
});

describe('mentionTokens', () => {
  it('first word of each @mention, lower-cased', () => {
    expect(mentionTokens('ask @Quarterly taxes and @Main. and @X')).toEqual([
      'quarterly',
      'main',
      'x',
    ]);
  });
});

describe('onlyReferenced — the transcript’s references, nothing else the cache holds', () => {
  it('keeps referenced ids, chats owning referenced panes, and FULL-name mentions only', () => {
    const groups = [
      {
        id: 'w',
        tabs: [
          { id: 't-old', name: 'Old', layout: 'p1' },
          { id: 't-search-hit', name: 'Quarterly other', layout: 'p9' },
          { id: 't-named', name: 'Quarterly taxes', layout: 'p8' },
        ],
      },
      { id: 'x', tabs: [{ id: 't-marker', name: 'M', layout: 'p-m' }] },
    ];
    expect(
      onlyReferenced(groups, {
        tabIds: ['t-old'],
        paneIds: ['p-m'],
        nameText: 'see @quarterly taxes today',
      }),
    ).toEqual([
      {
        id: 'w',
        tabs: [
          { id: 't-old', name: 'Old', layout: 'p1' },
          { id: 't-named', name: 'Quarterly taxes', layout: 'p8' },
        ],
      },
      { id: 'x', tabs: [{ id: 't-marker', name: 'M', layout: 'p-m' }] },
    ]);
  });
});
