import type { Tab, Workspace } from '@muxpad/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * THE FLAT 'RECENT' LIST, AS RENDERED — the other half of lib/flat-chats.test.
 *
 * That file pins the RULE: a child travels with its parent, pins float, the
 * done drawer is one. This pins the HANDOFF from that rule to the rows, which
 * is the seam that has actually broken here before — `renderRow` once failed to
 * forward `parent` to `<TabRow>`, so `data-child` reached no element in the
 * product while both the grouping test and the stylesheet test stayed green
 * about their own halves (see NavTree.rows.test.tsx, which is this file's
 * sibling for the per-workspace list).
 *
 * The flat list re-implements that handoff for a second time, over rows from
 * different workspaces, so it needs its own arm: a child's indent and its dot
 * are statements about the row DIRECTLY ABOVE it, and in a list merged from
 * three workspaces there is nothing in the type system that keeps them
 * adjacent.
 *
 * Static markup, same as its sibling, and the same four ambient mocks — the
 * router and the two caches. The component under test is the real one.
 */

let CORPUS: { id: string; slug: string; name: string; tabs: Tab[] }[] = [];

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  useNavigate: () => () => {},
}));

vi.mock('../tabs', () => ({
  useTabs: () => ({ tabs: [], refresh: async () => {} }),
  cachedTabsFor: () => [],
  refreshTabs: async () => {},
  applyTabOrder: () => {},
  applyTabUnread: () => {},
}));

vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({
    workspaces: CORPUS.map((g) => ({ id: g.id, slug: g.slug, name: g.name }) as Workspace),
    refresh: async () => [],
  }),
  visibleWorkspaces: (w: Workspace[]) => w,
  refreshWorkspaces: async () => {},
  applyWorkspaceOrder: () => {},
}));

vi.mock('../lib/all-tabs', () => ({
  cachedAllTabs: () => CORPUS,
  loadAllTabs: async () => CORPUS,
  subscribeAllTabs: () => () => {},
}));

const { NavTree } = await import('./NavTree');
const { setNavView, resetNavView, DEFAULT_NAV_VIEW } = await import('../lib/nav-view');

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    name: id,
    slug: id,
    created_at: NOW,
    updated_at: NOW,
    layout: { type: 'pane', id: `${id}-p` },
    done: false,
    last_user_at: NOW,
    last_activity_at: NOW,
    ...over,
  } as Tab;
}

/** Render the flat view of a corpus. `variant` because the two surfaces draw
 *  the workspace label in different cells and both have to actually emit it. */
function flatHtml(
  corpus: { slug: string; tabs: Tab[] }[],
  opts: { variant: 'sheet' | 'sidebar'; activeWorkspaceSlug?: string },
): string {
  CORPUS = corpus.map((g) => ({ id: `w-${g.slug}`, slug: g.slug, name: g.slug, tabs: g.tabs }));
  // ASKED FOR, EXPLICITLY. This used to lean on an empty localStorage falling
  // through to a default of 'recent' — the comment here even said that if the
  // default flipped these would all break, "which is correct". It flipped (the
  // flat list was a mess to live with once it was the thing you landed on), so
  // the tests say what they mean instead: this file is about the flat list as
  // RENDERED, not about which view you get for free. That question now has one
  // test of its own, below, and it is the only one that reads the default.
  resetNavView();
  setNavView(opts.variant, 'recent');
  return renderToStaticMarkup(
    <NavTree
      variant={opts.variant}
      activeWorkspaceSlug={opts.activeWorkspaceSlug ?? 'personal'}
      activeTabSlug={null}
    />,
  );
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * The CHAT names in the order they appear in the markup.
 *
 * Scoped to `.navtree-tab-link`, not to `.navtree-name-text` alone: that class
 * is also worn by the "Hosted" foot link, which both variants render below the
 * list, and by the picker's workspace rows. Matching the row's own link is what
 * makes this an assertion about the chat list rather than about the nav.
 */
function order(html: string): string[] {
  return [
    ...html.matchAll(/class="navtree-tab-link"[\s\S]*?class="navtree-name-text"[^>]*>([^<]+)</g),
  ].map((m) => m[1] as string);
}

describe('the flat view is a CHOICE, and the grouped one is the default', () => {
  // The one assertion in this file about which view you get for free. It reads
  // DEFAULT_NAV_VIEW rather than restating 'spaces', so flipping the default
  // again is a one-line change in one place and this test follows it.
  it('is not what you get without asking — grouping is', () => {
    expect(DEFAULT_NAV_VIEW).toBe('spaces');
  });

  it('puts both workspaces in ONE list once you do ask, on both surfaces', () => {
    const corpus = [
      { slug: 'personal', tabs: [tab('p1', { last_user_at: NOW - 3 * HOUR })] },
      { slug: 'trayo', tabs: [tab('t1', { last_user_at: NOW })] },
    ];
    for (const variant of ['sheet', 'sidebar'] as const) {
      const html = flatHtml(corpus, { variant });
      // Both workspaces' chats in ONE list — which the grouped view, by
      // construction, cannot produce on either surface.
      expect({ variant, order: order(html) }).toEqual({ variant, order: ['t1', 'p1'] });
    }
  });

  it('orders on YOUR touch, so a chat tailing a log cannot take the top', () => {
    const html = flatHtml(
      [
        {
          slug: 'personal',
          tabs: [
            tab('noisy', {
              status: 'working',
              last_activity_at: NOW,
              last_user_at: NOW - 7 * 24 * HOUR,
            }),
            tab('mine', { last_activity_at: NOW - HOUR, last_user_at: NOW - HOUR }),
          ],
        },
      ],
      { variant: 'sheet' },
    );
    expect(order(html)).toEqual(['mine', 'noisy']);
  });
});

describe('a CHILD row still looks like a child in a list merged from three workspaces', () => {
  const corpus = () => [
    { slug: 'personal', tabs: [tab('root'), tab('kid', { spawned_by: 'root' })] },
    { slug: 'trayo', tabs: [tab('elsewhere', { last_user_at: NOW - HOUR })] },
  ];

  it('marks the child, and only the child', () => {
    // `data-child="true"` is what the one indent step hangs on (NavTree.css,
    // pinned by NavTree.spacing.test.ts). Its absence is what made that rule
    // dead once already.
    expect(count(flatHtml(corpus(), { variant: 'sheet' }), 'data-child="true"')).toBe(1);
    expect(count(flatHtml(corpus(), { variant: 'sidebar' }), 'data-child="true"')).toBe(1);
  });

  it('renders the child DIRECTLY under its own parent, never next to a stranger', () => {
    // THE assertion this list needs and the per-workspace one does not: the
    // child's mark sits in its parent's column and its indent is measured
    // against the row above, so adjacency is not decoration — it is what makes
    // the row readable at all.
    const names = order(flatHtml(corpus(), { variant: 'sheet' }));
    expect(names.indexOf('kid')).toBe(names.indexOf('root') + 1);
  });

  it('draws the parent as a TILE and the child as a DOT, one each', () => {
    const html = flatHtml(corpus(), { variant: 'sidebar' });
    expect(count(html, 'data-shape="dot"')).toBe(1);
    // Two roots in this corpus (`root` and `elsewhere`), each with a tile.
    expect(count(html, 'data-shape="tile"')).toBe(2);
  });
});

describe('in a list that mixes workspaces, every row says which one', () => {
  const corpus = [
    { slug: 'personal', tabs: [tab('here')] },
    { slug: 'trayo', tabs: [tab('there', { last_user_at: NOW - HOUR })] },
  ];

  it('labels BOTH rows on the SHEET, including the one you are in', () => {
    // The rule used to leave the home row bare, on the reasoning that the bar
    // already names that workspace. In the flat view the bar names no
    // workspace — it says "Recent" — so the bare row silently meant "local",
    // and the user reported exactly that as not being able to tell which
    // workspace a tab belongs to.
    const html = flatHtml(corpus, { variant: 'sheet', activeWorkspaceSlug: 'personal' });
    expect(count(html, 'navtree-rail-ws')).toBe(2);
    expect(html).toContain('>trayo<');
    expect(html).toContain('>personal<');
  });

  it('labels both on the RAIL too, in the meta cell', () => {
    const html = flatHtml(corpus, { variant: 'sidebar', activeWorkspaceSlug: 'personal' });
    expect(count(html, 'navtree-tab-ws')).toBe(2);
  });

  it('is symmetric — which workspace you are in changes nothing here', () => {
    const html = flatHtml(corpus, { variant: 'sheet', activeWorkspaceSlug: 'trayo' });
    expect(count(html, 'navtree-rail-ws')).toBe(2);
    expect(html).toContain('>personal<');
    expect(html).toContain('>trayo<');
  });

  it('does not repeat the label on a child — the parent above already said it', () => {
    const html = flatHtml(
      [
        { slug: 'personal', tabs: [] },
        { slug: 'trayo', tabs: [tab('root'), tab('kid', { spawned_by: 'root' })] },
      ],
      { variant: 'sheet', activeWorkspaceSlug: 'personal' },
    );
    expect(count(html, 'navtree-rail-ws')).toBe(1);
  });
});

describe('the drawer and the pins survive the flattening', () => {
  it('folds every workspace’s done chats into ONE collapsed drawer', () => {
    const html = flatHtml(
      [
        { slug: 'personal', tabs: [tab('live'), tab('gone', { done: true })] },
        { slug: 'trayo', tabs: [tab('gone2', { done: true })] },
      ],
      { variant: 'sheet' },
    );
    expect(count(html, 'navtree-done-head')).toBe(1);
    expect(html).toContain('2 done');
    // Collapsed by default: a chat crossing into done should be something you
    // notice LEAVING, not something that opens a drawer under it.
    expect(order(html)).toEqual(['live']);
  });

  it('floats a pinned chat from another workspace above everything', () => {
    const html = flatHtml(
      [
        { slug: 'personal', tabs: [tab('fresh', { last_user_at: NOW })] },
        {
          slug: 'trayo',
          tabs: [tab('kept', { pinned: true, last_user_at: NOW - 30 * 24 * HOUR })],
        },
      ],
      { variant: 'sheet' },
    );
    expect(order(html)).toEqual(['kept', 'fresh']);
  });
});
