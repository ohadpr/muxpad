import type { Tab, Workspace } from '@muxpad/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

/**
 * THE DELIVERED CHILD, which only exists behind a click.
 *
 * A sub-chat retires the moment it reports, so the one row whose mark is the
 * HOLLOW RING is always inside the done drawer — and the drawer is collapsed by
 * default, deliberately. Static markup therefore cannot reach the case where the
 * sidebar and the `@` picker used to disagree about the same chat: the picker
 * inferred a dot from `spawned_by` and drew the ring, while the sidebar forced a
 * tile and — a retired sub-chat having `clock: null` — took the chip's
 * no-clock/fresh branch, so one surface said "delivered" and the other said
 * "brand new".
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('opening the done drawer shows a delivered child as a hollow dot', () => {
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  function mountRail(tabs: Tab[]): HTMLDivElement {
    TABS = tabs;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <TabList
          workspace={WS}
          isActiveWorkspace={true}
          activeTabSlug={null}
          variant="sidebar"
          editing={null}
          setEditing={() => {}}
        />,
      );
    });
    return host;
  }

  it('keeps the drawer shut until asked, then draws the ring in the mark column', () => {
    // A live parent with one delivered sub-chat: it contributes a live row up top
    // and a `contextOnly` label with the child under it, down in the drawer.
    const box = mountRail([
      tab('root'),
      // No clock at all — a sub-chat does not decay, it delivers (groupChats).
      tab('kid', { spawned_by: 'root', done: true, done_reason: 'delivered', clock: null }),
    ]);
    expect(box.querySelector('.navtree-done-head')?.textContent).toContain('1 done');
    // COLLAPSED by default: a chat leaving the live list must not re-open a
    // drawer of finished ones under it.
    expect(box.querySelectorAll('[data-shape="dot"]')).toHaveLength(0);

    act(() => box.querySelector<HTMLButtonElement>('.navtree-done-head')?.click());

    const dots = box.querySelectorAll('[data-shape="dot"]');
    expect(dots).toHaveLength(1);
    // Hollow, not solid — "finished, not gone", the dot's whole second state.
    expect(box.querySelectorAll('.chatchip-dot[data-hollow="true"]')).toHaveLength(1);
    // …and it is a CHILD row, so its dot lands in the column its parent's tile
    // occupies and its name shares the tree's one child x.
    expect(box.querySelectorAll('.navtree-tab-row[data-child="true"]')).toHaveLength(1);
    // The parent above is a label here, not a second clickable copy of the row
    // that is still live at the top of the list.
    expect(box.querySelector('.navtree-done-parent')?.textContent).toBe('root');
  });

  it('draws a working child as a SOLID dot in the live list', () => {
    // The other half of the two-state vocabulary, and the reason the drawer is
    // not the only place a dot appears.
    const box = mountRail([tab('root'), tab('kid', { spawned_by: 'root', clock: null })]);
    expect(box.querySelectorAll('[data-shape="dot"]')).toHaveLength(1);
    expect(box.querySelectorAll('.chatchip-dot[data-hollow="true"]')).toHaveLength(0);
    expect(box.querySelector('.navtree-done-head')).toBeNull();
  });
});

/**
 * THE SHEET, which had no nesting at all.
 *
 * The desktop rail's half of this was fixed three times (see the header above);
 * the sheet's half had never been built. `TabList` mapped every chat to
 * `{children: []}` and dropped `done` entirely when `variant === 'sheet'`, on
 * the stated reasoning that the mobile rail is one flat line per chat by design.
 *
 * What that cost, reported from the phone with a screenshot: two agents spawned
 * under `muxpad` rendered as top-level rows sorted by recency, which put them
 * ABOVE their own parent with full-size emoji and no mark on them — and because
 * the done drawer is where both decay and retirement file a chat, nothing ever
 * left the live list on the one device this list actually gets read on.
 *
 * Every assertion here failed before the fix. They are written against the
 * SHEET's own vocabulary — no tile (the plate is deleted on this surface), a dot
 * for a child, and the shared done header — not against the desktop's.
 */
describe('the sheet nests a child under its parent and files done chats away', () => {
  const sheetHtml = (tabs: Tab[]): string => {
    TABS = tabs;
    return renderToStaticMarkup(
      <TabList
        workspace={WS}
        isActiveWorkspace={true}
        activeTabSlug={null}
        variant="sheet"
        editing={null}
        setEditing={() => {}}
      />,
    );
  };

  it('marks the child row as a child, so the indent rule can reach it', () => {
    // `data-child` was emitted by the desktop row and not by the sheet's, so
    // even once the grouping arrived a child would have been an ordinary line.
    const out = sheetHtml([tab('root'), tab('kid', { spawned_by: 'root', clock: null })]);
    expect(count(out, 'data-child="true"')).toBe(1);
  });

  it('gives the child a dot in the emoji column and the parent its bare emoji', () => {
    // The dot is what makes this read as nesting: it stands in the emoji's own
    // fixed box, which lands every child name on one x. The parent keeps the
    // plateless emoji this surface is built on — no tile is introduced here.
    const out = sheetHtml([tab('root'), tab('kid', { spawned_by: 'root', clock: null })]);
    expect(count(out, 'data-shape="dot"')).toBe(1);
    expect(out).not.toContain('data-shape="tile"');
  });

  it('puts the child AFTER its parent, whatever the flat order says', () => {
    // The reported symptom exactly: recency sorted the fresh sub-chats above the
    // chat that spawned them. Grouping is what makes position mean parentage
    // instead of last-touched, so the child must follow its parent even when the
    // incoming list has it first.
    const out = sheetHtml([tab('kid', { spawned_by: 'root', clock: null }), tab('root')]);
    expect(out.indexOf('>root<')).toBeLessThan(out.indexOf('>kid<'));
  });

  it('moves a decayed chat into the done drawer instead of leaving it live', () => {
    // The drawer was `[]` on this variant, so a chat the server had already
    // marked done stayed in the live list forever. The header is the shared one.
    const out = sheetHtml([tab('root'), tab('old', { done: true })]);
    expect(out).toContain('1 done');
    // Collapsed by default here too, so the decayed row is not in the markup.
    expect(out).not.toContain('>old<');
  });

  it('leaves a flat list flat — no marks, no drawer', () => {
    // Guards the four above: they must be reporting the hierarchy, not a
    // grouping pass that decorates every row it touches.
    const out = sheetHtml([tab('root'), tab('other')]);
    expect(out).not.toContain('data-child="true"');
    expect(out).not.toContain('data-shape="dot"');
    expect(out).not.toContain('done');
  });
});
