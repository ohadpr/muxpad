import type { Tab, Workspace } from '@muxpad/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

/**
 * THE RENDERED LIST — the assertion that was missing.
 *
 * `groupChats` is unit-tested to death (NavTree.chats.test.tsx) and the row's
 * geometry is pinned to the pixel (NavTree.spacing.test.ts). Between the two sat
 * the thing neither could see: `renderRow` never forwarded `parent` to
 * `<TabRow>`, so `data-child` was never emitted on any element and every child
 * drew a TILE. The grouping was right, the stylesheet was right, and the product
 * shipped with no child rows in it — the indent and the dot-in-the-mark-column
 * that three rounds of design bought did not exist.
 *
 * A stylesheet test cannot catch that (the rule it asserts is correct — nothing
 * matches it) and a grouping test cannot either (it never renders). So this file
 * asserts the HANDOFF: what the browser is handed for a parent and a child.
 *
 * Static markup, like the other component tests here. The mocks are the four
 * ambient things a sidebar row reaches for — the router, the tab cache, the
 * workspace cache — and nothing else: the component under test is the real one.
 */

let TABS: Tab[] = [];

vi.mock('@tanstack/react-router', () => ({
  // Only the children and the class matter here; `to`/`params` would render as
  // stray attributes and tell us nothing. A <span>, not an <a>, so the stub does
  // not have to invent an href it has no route table to build.
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  useNavigate: () => () => {},
}));

vi.mock('../tabs', () => ({
  useTabs: () => ({ tabs: TABS, refresh: async () => {} }),
  refreshTabs: async () => {},
  applyTabOrder: () => {},
  applyTabUnread: () => {},
}));

vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [], refresh: async () => [] }),
  visibleWorkspaces: (w: Workspace[]) => w,
  refreshWorkspaces: async () => {},
  applyWorkspaceOrder: () => {},
}));

const { TabList } = await import('./NavTree');

const NOW = 1_700_000_000_000;

const WS: Workspace = {
  id: 'w1',
  name: 'Personal',
  slug: 'personal',
  created_at: NOW,
  updated_at: NOW,
} as Workspace;

/** A tab as the server publishes it. A SUB-CHAT HAS NO CLOCK — see groupChats. */
function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    name: id,
    slug: id,
    created_at: NOW,
    updated_at: NOW,
    layout: { type: 'pane', id: `${id}-p` },
    done: false,
    ...over,
  } as Tab;
}

function railHtml(tabs: Tab[]): string {
  TABS = tabs;
  return renderToStaticMarkup(
    <TabList
      workspace={WS}
      isActiveWorkspace={true}
      activeTabSlug={null}
      variant="sidebar"
      editing={null}
      setEditing={() => {}}
    />,
  );
}

/** How many times `needle` occurs — a count, because "at least one" would pass
 *  on a list that renders the child's mark twice or the parent's not at all. */
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('the rail hands a child row the things that make it look like a child', () => {
  const rail = () => railHtml([tab('root'), tab('kid', { spawned_by: 'root' })]);

  it('marks the child row, and only the child row, as a child', () => {
    // `data-child="true"` is what NavTree.css hangs the one indent step on. Its
    // absence is what made that rule dead, and a passing spacing test a lie.
    expect(count(rail(), 'data-child="true"')).toBe(1);
  });

  it('draws the parent as a TILE and the child as a DOT, one each', () => {
    // The dot is the whole point of the mark column: a child's 6px dot sits in
    // the box the parent's 24px tile occupies, which is what puts every child
    // name in the tree on one shared x.
    const out = rail();
    expect(count(out, 'data-shape="tile"')).toBe(1);
    expect(count(out, 'data-shape="dot"')).toBe(1);
  });

  it('a list with no children draws no dot and marks no row', () => {
    // Guards the guard: if the two above ever pass by accident, this fails.
    const out = railHtml([tab('root'), tab('other')]);
    expect(count(out, 'data-shape="tile"')).toBe(2);
    expect(out).not.toContain('data-shape="dot"');
    expect(out).not.toContain('data-child="true"');
  });

  it('draws a promoted orphan as a top-level TILE, never a stray dot', () => {
    // A `spawned_by` that does not resolve in this list makes the chat a
    // top-level row (groupChats), and a dot with no parent row above it belongs
    // to nothing. The shape is TOLD by the row, not inferred from the column.
    const out = railHtml([tab('root'), tab('orphan', { spawned_by: 'gone' })]);
    expect(count(out, 'data-shape="tile"')).toBe(2);
    expect(out).not.toContain('data-shape="dot"');
  });
});
