// The sidebar search's instant tier: the ranking rule and the highlight
// offsets. Pure functions, so they are tested directly rather than through a
// rendered box — the offsets in particular are where highlight bugs live, and
// a DOM assertion would only tell us that SOMETHING was bold.
import type { PaneStatus, Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import {
  RECENT_LIMIT,
  type SearchableTab,
  type WorkspaceTabs,
  paneIndex,
  rankTabs,
  recentTabs,
  snippetParts,
  splitHighlight,
  tabSlugFromPath,
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
const titles = (rows: ReturnType<typeof recentTabs>) => rows.map((r) => r.tab.tabName);

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
    // The limit slices the SORTED list. What survives is now decided by
    // COVERAGE first — `invest` is 6 of the 8 characters in "invest 0" and 6
    // of the 10 in "invest 499" — and only then by recency. So the winners are
    // the short names, most recent first: t9, not t499. (This assertion used
    // to read t499, from when every one of these 500 rows scored identically
    // and recency was the only thing left to sort on. The corpus is dated
    // 1970, so the recency term is zero for all of them.)
    expect(top[0]?.tab.tabId).toBe('t9');
  });

  it('…and among names of EQUAL length, recency is what decides', () => {
    const now = 1_700_000_000_000;
    const tabs = Array.from({ length: 20 }, (_, i) =>
      tab({ tabName: `invest ${10 + i}`, tabId: `t${i}`, lastActivityAt: now - i * 60_000 }),
    );
    const top = rankTabs(tabs, 'invest', { limit: 3, now });
    expect(top.map((m) => m.tab.tabId)).toEqual(['t0', 't1', 't2']);
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

describe('the “ra” problem — ties decided by the wrong thing', () => {
  const NOW = 1_700_000_000_000;
  const hour = (h: number) => NOW - h * 3_600_000;
  const t = (over: Partial<SearchableTab> & { tabName: string }): SearchableTab => ({
    tabId: over.tabName,
    tabSlug: over.tabName,
    workspaceId: 'w',
    workspaceSlug: 'w',
    workspaceName: 'Personal',
    paneIds: [],
    ...over,
  });

  /** The screenshot, as data: five prefix matches on `ra`, the sub-chats the
   *  most recently touched. Before this, all five scored exactly namePrefix
   *  and recency alone put `rail status …` on top of `radar archive`. */
  const corpus = [
    t({ tabName: 'rail status design critique', lastActivityAt: hour(0.2), done: true }),
    t({ tabName: 'rail search button deep read', lastActivityAt: hour(0.5), done: true }),
    t({ tabName: 'radar archive', lastActivityAt: hour(6) }),
    t({ tabName: 'radar', lastActivityAt: hour(30) }),
    t({ tabName: 'Rat a rat card redesign', lastActivityAt: hour(50) }),
  ];
  const names = (q: string) => rankTabs(corpus, q, { now: NOW }).map((m) => m.tab.tabName);

  it('puts the chats you meant above the workers that just finished', () => {
    const out = names('ra');
    expect(out.slice(0, 2)).toEqual(['radar', 'radar archive']);
    expect(out.indexOf('radar archive')).toBeLessThan(out.indexOf('rail status design critique'));
  });

  it('prefers the SHORTER name — the query covers more of it', () => {
    // `ra` is 40% of "radar" and 9% of "Rat a rat card redesign", and the
    // short one is the one a person typing two letters meant.
    expect(names('ra').indexOf('radar')).toBeLessThan(
      names('ra').indexOf('Rat a rat card redesign'),
    );
  });

  it('…but coverage never beats a better MATCH', () => {
    // "radar" is an exact match; "radar archive" is a longer prefix match with
    // every other advantage. The band must hold.
    const out = names('radar');
    expect(out[0]).toBe('radar');
  });

  it('recency separates two equal matches and nothing more', () => {
    const a = t({ tabName: 'alpha notes', lastActivityAt: hour(0.1) });
    const b = t({ tabName: 'alpha notes two', lastActivityAt: hour(24 * 30) });
    // Same kind of match on both; the fresh one wins.
    expect(rankTabs([b, a], 'alpha', { now: NOW })[0]?.tab.tabName).toBe('alpha notes');
    // A HEADLINE match on a chat touched one second ago still loses to a name
    // match on one touched a month ago.
    const stale = t({ tabName: 'zebra', lastActivityAt: hour(24 * 30) });
    const fresh = t({ tabName: 'nothing like it', headline: 'zebra', lastActivityAt: hour(0.01) });
    expect(rankTabs([fresh, stale], 'zebra', { now: NOW })[0]?.tab.tabName).toBe('zebra');
  });

  it('keeps every boost inside one band, which is the whole invariant', () => {
    // pinned + full coverage + just-touched, on the WEAKEST name match, must
    // still lose to the strongest headline match it could meet. (It cannot:
    // the bands are 20 apart and the boosts total 18.)
    const loud = t({
      tabName: 'xq',
      lastActivityAt: NOW,
      pinned: true,
    });
    // A substring match on 'q' inside 'xq' …
    const sub = rankTabs([loud], 'q', { now: NOW })[0];
    const head = rankTabs([t({ tabName: 'nothing', headline: 'q', lastActivityAt: NOW })], 'q', {
      now: NOW,
    })[0];
    expect(sub?.score).toBeGreaterThan(head?.score ?? 0);
  });

  it('is still a TOTAL order — two renders of one corpus agree', () => {
    const once = names('ra');
    const twice = names('ra');
    expect(once).toEqual(twice);
  });
});

/**
 * THE EMPTY QUERY. This list is what replaced the rail's "Recently active"
 * band, so the properties the band had — a stable order, your own activity
 * rather than an agent's, and no duplicate of the row you are standing on —
 * are the ones asserted here.
 */
describe('recentTabs', () => {
  const T = 1_800_000_000_000;
  const touched = (name: string, lastUserAt: number | null) => tab({ tabName: name, lastUserAt });

  it('orders by the last time YOU touched it, newest first', () => {
    const rows = recentTabs([
      touched('old', T - 86_400_000),
      touched('now', T),
      touched('hour', T - 3_600_000),
    ]);
    expect(rows.map((r) => r.tab.tabName)).toEqual(['now', 'hour', 'old']);
  });

  it('ignores machine activity — a chat tailing a log does not hold the top', () => {
    // The measurement behind `userTouchAt`: six working chats held six of the
    // global top seven, none of it anything the user had done. `lastActivityAt`
    // is bumped by pty output; it must not outrank a real touch.
    const chatty = tab({ tabName: 'tailing a log', lastUserAt: T - 7 * 86_400_000 });
    chatty.lastActivityAt = T;
    const mine = touched('what I was doing', T - 3_600_000);
    expect(recentTabs([chatty, mine]).map((r) => r.tab.tabName)).toEqual([
      'what I was doing',
      'tailing a log',
    ]);
  });

  it('falls back to machine activity only when there is no user stamp at all', () => {
    // An OLDER SERVER with no `last_user_at` column is the only way that
    // happens, and degrading it to today's ordering beats no ordering.
    const a = tab({ tabName: 'a' });
    a.lastActivityAt = T;
    const b = tab({ tabName: 'b' });
    b.lastActivityAt = T - 1000;
    expect(recentTabs([a, b]).map((r) => r.tab.tabName)).toEqual(['a', 'b']);
  });

  it('sorts a chat with no timestamp at all LAST, not first', () => {
    // `null` means "we do not know when", and reading it as "just now" would
    // put the least-known rows at the top of a list whose claim is recency.
    const rows = recentTabs([touched('unknown', null), touched('known', T - 86_400_000)]);
    expect(rows.map((r) => r.tab.tabName)).toEqual(['known', 'unknown']);
  });

  it('leaves out the chat you are standing on, by id or by slug', () => {
    // Without this the cursor starts on the chat you opened the palette FROM,
    // and the first Enter — the whole point of a keyboard switcher — is a no-op.
    //
    // BOTH KEYS, and the id/slug distinction is the whole reason: the caller
    // reads a SLUG off the route (`/w/house/t/here`), while everything else in
    // the corpus is keyed by id. A fixture where the two are the same string
    // cannot tell those apart — this one gives the row a ULID-ish id so a
    // lookup that only checks `tabId` fails here instead of in the palette.
    const here = tab({ tabName: 'here', tabId: '01M7R437DA', tabSlug: 'here', lastUserAt: T });
    const tabs = [here, touched('there', T - 1)];
    expect(recentTabs(tabs, { exclude: 'here' }).map((r) => r.tab.tabName)).toEqual(['there']);
    expect(recentTabs(tabs, { exclude: '01M7R437DA' }).map((r) => r.tab.tabName)).toEqual([
      'there',
    ]);
    expect(recentTabs(tabs, { exclude: 'nowhere' })).toHaveLength(2);
  });

  it('does not promote a blocked chat', () => {
    // A list that reorders itself on an agent's state is the churn feed this
    // replaced. The row still carries its dot where it sits.
    const rows = recentTabs([
      tab({ tabName: 'blocked', status: 'blocked', lastUserAt: T - 86_400_000 }),
      touched('recent', T),
    ]);
    expect(rows.map((r) => r.tab.tabName)).toEqual(['recent', 'blocked']);
    expect(rows[1]?.tab.status).toBe('blocked');
  });

  it('leaves out a WORKER, which is not a place you go back to', () => {
    // THE REGRESSION THIS FILE EXISTS FOR, found by reading the live corpus
    // after shipping: `/api/tabs/all` is 1,111 rows on this machine and 964
    // of them are sub-chats. A sub-chat's `last_user_at` is stamped at
    // CREATION, so eight freshly spawned workers would take every slot in the
    // switcher.
    //
    // The band this replaced could not do that because its working set was
    // fed by `TabActivity.touchTab`, which skips a sub-chat explicitly. That
    // exclusion was load-bearing and did not come across with the feature.
    const worker = tab({ tabName: 'review the diff', lastUserAt: T, spawnedBy: 'parent' });
    const conversation = touched('muxpad', T - 3_600_000);
    expect(titles(recentTabs([worker, conversation]))).toEqual(['muxpad']);
  });

  it('leaves out a chat that is OVER', () => {
    // 1,091 of those 1,111 rows are `done` — archived, decayed, or a worker
    // that delivered. The clock calls a chat done after four days untouched,
    // which is the opposite of what you were just doing. Typing still finds
    // it, under its own penalty.
    const archived = tab({ tabName: 'old thing', lastUserAt: T, done: true });
    const live = touched('muxpad', T - 3_600_000);
    expect(titles(recentTabs([archived, live]))).toEqual(['muxpad']);
  });

  it('can come back empty rather than padding with finished work', () => {
    // A fresh profile, or a machine where everything has decayed. An empty
    // recents list is honest; eight dead rows are not, and the palette has a
    // placeholder for exactly this.
    expect(recentTabs([tab({ tabName: 'gone', lastUserAt: T, done: true })])).toEqual([]);
  });

  it('caps the list and honours an explicit limit', () => {
    const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => touched(`c${i}`, T - i * 1000));
    expect(recentTabs(many)).toHaveLength(RECENT_LIMIT);
    expect(recentTabs(many, { limit: 3 })).toHaveLength(3);
    expect(recentTabs(many, { limit: 0 })).toEqual([]);
  });

  it('breaks an exact tie totally, so the list cannot swap under a re-render', () => {
    const rows = recentTabs([touched('b', T), touched('a', T)]);
    expect(rows.map((r) => r.tab.tabName)).toEqual(['a', 'b']);
  });

  it('does not mutate the corpus it was handed', () => {
    const tabs = [touched('old', T - 1000), touched('new', T)];
    recentTabs(tabs);
    expect(tabs.map((t) => t.tabName)).toEqual(['old', 'new']);
  });

  it('carries no highlight range, so a row renders its name plain', () => {
    const row = recentTabs([touched('Investing', T)])[0];
    expect(row?.range).toBeUndefined();
    expect(splitHighlight('Investing', row?.range)).toEqual(['Investing', '', '']);
  });
});

describe('tabSlugFromPath', () => {
  it('finds the tab slug in a chat route', () => {
    expect(tabSlugFromPath('/w/personal/t/investing')).toBe('investing');
  });

  it('ignores the query string and the hash', () => {
    expect(tabSlugFromPath('/w/personal/t/investing?logs=true#x')).toBe('investing');
  });

  it('decodes an escaped slug', () => {
    expect(tabSlugFromPath('/w/personal/t/%D7%91%D7%A0%D7%99%D7%9E%D7%99%D7%A0%D7%94')).toBe(
      'בנימינה',
    );
  });

  it('returns the raw segment rather than throwing on a malformed escape', () => {
    expect(tabSlugFromPath('/w/personal/t/100%')).toBe('100%');
  });

  it('has no answer for a path with no tab — which excludes nothing', () => {
    expect(tabSlugFromPath('/hosted')).toBeUndefined();
    expect(tabSlugFromPath('/w/personal')).toBeUndefined();
  });
});

/**
 * THE CORPUS BUILDER DROPPED TWO FIELDS THE WIRE WAS ALREADY CARRYING, and
 * both mattered: `done` left `SCORE.donePenalty` unreachable for every single
 * ⌘K query, and `spawned_by` left the recents list unable to tell a
 * conversation from a worker.
 *
 * Asserted against a real wire row rather than a hand-made one, because the
 * bug was precisely a field that exists upstream and stops here.
 */
describe('toSearchableTabs carries what the wire sends', () => {
  const wireTab = (over: Partial<Tab>): Tab =>
    ({
      id: 't1',
      slug: 't1',
      name: 'T',
      layout: JSON.stringify('p1'),
      created_at: 1,
      updated_at: 1,
      ...over,
    }) as Tab;

  const only = (over: Partial<Tab>) =>
    toSearchableTabs([{ id: 'w', slug: 'w', name: 'W', tabs: [wireTab(over)] }])[0];

  it('carries `done`, so the ranking penalty is reachable at all', () => {
    expect(only({ done: true } as Partial<Tab>)?.done).toBe(true);
    expect(only({ done: false } as Partial<Tab>)?.done).toBe(false);
  });

  it('carries `spawned_by`, so a worker is distinguishable from a chat', () => {
    expect(only({ spawned_by: 'parent' } as Partial<Tab>)?.spawnedBy).toBe('parent');
    expect(only({})?.spawnedBy).toBeUndefined();
  });

  it('sinks a done chat in a TYPED search too, rather than only in recents', () => {
    // What `donePenalty` was always meant to do and could not, because the
    // field never arrived. Same band, so the penalty only breaks the tie —
    // which is the whole design of the score bands.
    const rows = toSearchableTabs([
      {
        id: 'w',
        slug: 'w',
        name: 'W',
        tabs: [
          wireTab({ id: 'a', slug: 'a', name: 'radio', done: true } as Partial<Tab>),
          wireTab({ id: 'b', slug: 'b', name: 'radio', done: false } as Partial<Tab>),
        ],
      },
    ]);
    expect(rankTabs(rows, 'radio').map((m) => m.tab.tabId)).toEqual(['b', 'a']);
  });
});
