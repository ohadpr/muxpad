// The sidebar search's instant tier: the ranking rule and the highlight
// offsets. Pure functions, so they are tested directly rather than through a
// rendered box — the offsets in particular are where highlight bugs live, and
// a DOM assertion would only tell us that SOMETHING was bold.
import type { PaneStatus, Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import {
  type SearchableTab,
  type WorkspaceTabs,
  paneIndex,
  rankTabs,
  snippetParts,
  splitHighlight,
  toSearchableTabs,
} from './nav-search';

function tab(over: Partial<SearchableTab> & { tabName: string }): SearchableTab {
  return {
    tabId: over.tabName.toLowerCase(),
    tabSlug: over.tabName.toLowerCase(),
    workspaceId: 'w1',
    workspaceSlug: 'w1',
    workspaceName: 'House',
    paneIds: [],
    ...over,
  };
}

const names = (q: string, tabs: SearchableTab[]) => rankTabs(tabs, q).map((m) => m.tab.tabName);

describe('rankTabs — which field matched', () => {
  it('returns nothing for an empty or whitespace-only query', () => {
    const tabs = [tab({ tabName: 'Investing' })];
    expect(rankTabs(tabs, '')).toEqual([]);
    expect(rankTabs(tabs, '   ')).toEqual([]);
    // A tab is not a match for the absence of a query — the caller shows the
    // TREE at that point, and returning everything here would make the two
    // states race to render.
  });

  it('matches a single character', () => {
    expect(names('i', [tab({ tabName: 'Investing' }), tab({ tabName: 'Roadmap' })])).toEqual([
      'Investing',
    ]);
  });

  it('orders exact > prefix > word-prefix > substring, all above headline and workspace', () => {
    const tabs = [
      tab({ tabName: 'zzz', headline: 'notes about inv' }), // headline
      tab({ tabName: 'Investing plan' }), // prefix
      tab({ tabName: 'inv' }), // exact
      tab({ tabName: 'reinvest' }), // substring (mid-word)
      tab({ tabName: 'My Investing notes' }), // word prefix
      tab({ tabName: 'qqq', workspaceName: 'Inv house' }), // workspace
    ];
    expect(names('inv', tabs)).toEqual([
      'inv',
      'Investing plan',
      'My Investing notes',
      'reinvest',
      'zzz',
      'qqq',
    ]);
  });

  it('reports the field that matched, so the row highlights the right line', () => {
    const tabs = [tab({ tabName: 'zzz', headline: 'the cron scheduler' })];
    const [m] = rankTabs(tabs, 'cron');
    expect(m?.field).toBe('headline');
    expect(m?.range).toEqual([4, 8]);
  });

  it('a name match wins over the same tab’s headline — one row, one highlight', () => {
    const tabs = [tab({ tabName: 'cron', headline: 'cron cron cron' })];
    const [m] = rankTabs(tabs, 'cron');
    expect(m?.field).toBe('name');
  });

  it('falls through to the workspace name only when neither tab field matched', () => {
    const tabs = [tab({ tabName: 'Roadmap', workspaceName: 'Investing' })];
    const [m] = rankTabs(tabs, 'invest');
    expect(m?.field).toBe('workspace');
    expect(m?.range).toEqual([0, 6]);
  });

  it('is case-insensitive and keeps offsets in the ORIGINAL string', () => {
    const tabs = [tab({ tabName: 'My INVESTING Notes' })];
    const [m] = rankTabs(tabs, 'investing');
    expect(m?.range).toEqual([3, 12]);
    expect('My INVESTING Notes'.slice(3, 12)).toBe('INVESTING');
  });

  it('treats regex metacharacters as literal text', () => {
    // A user typing `(` mid-thought must not throw, and `a.c` must not match
    // "abc" — the box is a substring search, not a regex console.
    const tabs = [tab({ tabName: 'abc' }), tab({ tabName: 'a.c' }), tab({ tabName: 'plan (v2)' })];
    expect(names('a.c', tabs)).toEqual(['a.c']);
    expect(names('(v2', tabs)).toEqual(['plan (v2)']);
    expect(() => rankTabs(tabs, '[')).not.toThrow();
  });

  it('picks the STRONGEST placement when a name matches more than once', () => {
    // "plan" appears mid-word first and at a word start later; the later,
    // better placement is the one highlighted.
    const [m] = rankTabs([tab({ tabName: 'replanning the plan' })], 'plan');
    expect(m?.range).toEqual([15, 19]);
  });
});

describe('rankTabs — tie-breaks', () => {
  const same = (over: Partial<SearchableTab> & { tabName: string }) => tab(over);

  it('breaks a score tie by status: blocked before working before idle', () => {
    const tabs = [
      same({ tabName: 'inv c', status: 'idle' as PaneStatus }),
      same({ tabName: 'inv a', status: 'blocked' as PaneStatus }),
      same({ tabName: 'inv b', status: 'working' as PaneStatus }),
    ];
    expect(names('inv', tabs)).toEqual(['inv a', 'inv b', 'inv c']);
  });

  it('breaks a status tie by last activity, most recent first', () => {
    const tabs = [
      same({ tabName: 'inv a', status: 'idle' as PaneStatus, lastActivityAt: 100 }),
      same({ tabName: 'inv b', status: 'idle' as PaneStatus, lastActivityAt: 300 }),
      same({ tabName: 'inv c', status: 'idle' as PaneStatus, lastActivityAt: 200 }),
    ];
    expect(names('inv', tabs)).toEqual(['inv b', 'inv c', 'inv a']);
  });

  it('sorts a tab with no recorded activity last, never first', () => {
    const tabs = [
      same({ tabName: 'inv a', lastActivityAt: null }),
      same({ tabName: 'inv b', lastActivityAt: 1 }),
    ];
    expect(names('inv', tabs)).toEqual(['inv b', 'inv a']);
  });

  it('is a TOTAL order — identical rows still sort deterministically by name/id', () => {
    const tabs = [
      { ...same({ tabName: 'inv' }), tabId: 'b' },
      { ...same({ tabName: 'inv' }), tabId: 'a' },
    ];
    expect(rankTabs(tabs, 'inv').map((m) => m.tab.tabId)).toEqual(['a', 'b']);
  });

  it('gives pinned tabs a boost that cannot cross a band', () => {
    // Within the band: the pin wins the tie.
    const withinBand = [
      same({ tabName: 'inv b', lastActivityAt: 999 }),
      same({ tabName: 'inv a', pinned: true, lastActivityAt: 1 }),
    ];
    expect(names('inv', withinBand)).toEqual(['inv a', 'inv b']);
    // Across bands: a pinned HEADLINE match must not outrank an unpinned NAME
    // match. Pinning changes which of two equals comes first; it does not
    // change what the query hit.
    const acrossBands = [
      same({ tabName: 'zzz', headline: 'about inv', pinned: true }),
      same({ tabName: 'reinvest' }),
    ];
    expect(names('inv', acrossBands)).toEqual(['reinvest', 'zzz']);
  });
});

describe('rankTabs — scale', () => {
  it('handles a large corpus and honours the limit', () => {
    const tabs = Array.from({ length: 500 }, (_, i) =>
      tab({ tabName: `invest ${i}`, tabId: `t${i}`, lastActivityAt: i }),
    );
    const all = rankTabs(tabs, 'invest');
    expect(all).toHaveLength(500);
    const top = rankTabs(tabs, 'invest', { limit: 8 });
    expect(top).toHaveLength(8);
    // The limit slices the SORTED list, so the most recent are what survive.
    expect(top[0]?.tab.tabId).toBe('t499');
  });

  it('limit 0 returns nothing rather than everything', () => {
    expect(rankTabs([tab({ tabName: 'inv' })], 'inv', { limit: 0 })).toEqual([]);
  });
});

describe('splitHighlight', () => {
  it('splits into before / match / after', () => {
    expect(splitHighlight('My Investing notes', [3, 12])).toEqual(['My ', 'Investing', ' notes']);
  });

  it('degrades to no highlight for a range the text can no longer support', () => {
    // A live poll can replace a tab's name between the rank and the render.
    expect(splitHighlight('short', [3, 99])).toEqual(['short', '', '']);
    expect(splitHighlight('short', null)).toEqual(['short', '', '']);
    expect(splitHighlight('short', [2, 2])).toEqual(['short', '', '']);
  });
});

describe('snippetParts', () => {
  it('pulls the FTS5 guillemets out into hit runs', () => {
    expect(snippetParts('…the «cron» scheduler «fires»…')).toEqual([
      { text: '…the ', hit: false },
      { text: 'cron', hit: true },
      { text: ' scheduler ', hit: false },
      { text: 'fires', hit: true },
      { text: '…', hit: false },
    ]);
  });

  it('never loses content to an unbalanced delimiter', () => {
    // The snippet is a string we did not build; a stray marker must degrade to
    // plain text, not swallow the tail.
    expect(snippetParts('a «b')).toEqual([{ text: 'a «b', hit: false }]);
    expect(snippetParts('a » b')).toEqual([{ text: 'a » b', hit: false }]);
    expect(snippetParts('')).toEqual([]);
    expect(snippetParts('plain')).toEqual([{ text: 'plain', hit: false }]);
  });
});

describe('toSearchableTabs / paneIndex', () => {
  const groups: WorkspaceTabs[] = [
    {
      id: 'w1',
      slug: 'house',
      name: 'House',
      tabs: [
        {
          id: 't1',
          slug: 'investing',
          name: 'Investing',
          layout: 'p1',
          created_at: 1,
          updated_at: 1,
          headline: null,
          last_activity_at: 5,
        } as unknown as Tab,
        {
          id: 't2',
          slug: 'roadmap',
          name: 'Roadmap',
          layout: { direction: 'row', first: 'p2', second: 'p3' },
          created_at: 1,
          updated_at: 1,
        } as unknown as Tab,
      ],
    },
  ];

  it('carries the workspace name/slug onto every tab', () => {
    const flat = toSearchableTabs(groups);
    expect(flat.map((t) => t.workspaceName)).toEqual(['House', 'House']);
    expect(flat[0]?.workspaceSlug).toBe('house');
    // A null headline becomes absent, so `tab.headline ? …` reads correctly.
    expect(flat[0]?.headline).toBeUndefined();
  });

  it('collects every pane in the layout so a content hit can find its tab', () => {
    const idx = paneIndex(toSearchableTabs(groups));
    expect(idx.get('p1')?.tabName).toBe('Investing');
    expect(idx.get('p3')?.tabName).toBe('Roadmap');
    expect(idx.get('gone')).toBeUndefined();
  });
});
