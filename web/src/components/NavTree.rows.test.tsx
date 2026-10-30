import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Tab, type Workspace, chatClock } from '@muxpad/shared';
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

function railHtml(tabs: Tab[], activeTabSlug: string | null = null): string {
  TABS = tabs;
  return renderToStaticMarkup(
    <TabList
      workspace={WS}
      isActiveWorkspace={true}
      activeTabSlug={activeTabSlug}
      variant="sidebar"
      editing={null}
      setEditing={() => {}}
    />,
  );
}

/** How many times `needle` occurs — a count, because "at least one" would pass
 *  on a list that renders the child's mark twice or the parent's not at all. */
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * Open a parent's sub-chats, the way the reader does — through the remembered
 * set the rail reads on mount (lib/rail-folds).
 *
 * Static markup cannot click, and sub-chats are COLLAPSED by default, so every
 * assertion about what a child row looks like has to start by saying which
 * family is open. Seeding the store rather than exporting a test-only prop
 * keeps the persistence on the tested path: a rail that forgot the set would
 * fail these too.
 */
const openSubs = (...ids: string[]) =>
  localStorage.setItem('muxpad:rail-open-subs:v1', JSON.stringify(ids));
afterEach(() => localStorage.clear());

/** A clock `days` old, built by the SERVER's own deriver rather than by hand, so
 *  a change to the decay curve reaches these rows instead of a stale copy. */
const aged = (days: number) =>
  chatClock({ started_at: NOW - days * 86_400_000, now: NOW, pinned: false });

describe('the pinned edge', () => {
  /**
   * Pinned is a 2px accent bar on the row's leading rim — a channel nothing
   * else paints in, so it cannot be overruled by unread (which owns the ink),
   * by selection (which owns the fill) or by hover. The mark it replaces was a
   * hue on the name, which lost to unread and so appeared only while the row
   * had nothing to say.
   *
   * It is a NODE, not a pseudo: both of a tab row's are taken, and reaching
   * for either has produced the same bug twice.
   */
  const edges = (html: string) => count(html, 'navtree-pin-edge');

  it('draws one per pinned chat, and none on the rest', () => {
    const html = railHtml([
      tab('pinned-a', { pinned: true }),
      tab('pinned-b', { pinned: true }),
      tab('ordinary'),
    ]);
    expect(edges(html)).toBe(2);
  });

  it('draws it on a pinned chat that is also UNREAD — the case the hue lost', () => {
    const html = railHtml([tab('pinned', { pinned: true, unread: true })]);
    expect(edges(html)).toBe(1);
    expect(html).toContain('data-unread="true"');
  });

  it('does not mark a pinned chat’s sub-chat — a child is not pinned', () => {
    const html = railHtml([tab('pinned', { pinned: true }), tab('kid', { spawned_by: 'pinned' })]);
    expect(edges(html)).toBe(1);
  });

  it('draws nothing at all when nothing is pinned', () => {
    expect(edges(railHtml([tab('a'), tab('b')]))).toBe(0);
  });

  it('is hidden from the screen reader — the pin button already says it', () => {
    // `aria-pressed` on the pin control is the accessible statement; a second
    // announcement per row would be noise on every pinned chat.
    const html = railHtml([tab('pinned', { pinned: true })]);
    const at = html.indexOf('navtree-pin-edge');
    expect(html.slice(Math.max(0, at - 120), at + 40)).toContain('aria-hidden="true"');
  });
});

describe('the rail hands a child row the things that make it look like a child', () => {
  const rail = () => {
    openSubs('root');
    return railHtml([tab('root'), tab('kid', { spawned_by: 'root' })]);
  };

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

  it('ends the trunk on the LAST child, and marks exactly one', () => {
    // THE BUG THIS REPLACES. The trunk's continuation was a CSS sibling test —
    // `[data-child]:has(+ [data-child])` — which is a claim about DOM
    // ADJACENCY. It held on the rail and was FALSE on the sheet, where every
    // row is wrapped in a `.swiperow`, so no two child rows are ever siblings:
    // the rule never matched, every child's trunk stopped at its own middle,
    // and a family drew N detached brackets instead of one line. It shipped
    // that way from the day the trunk landed and was only visible once the ink
    // went up.
    // The index is a thing React knows. It is told now, on both surfaces, and
    // these assertions are what keep it told.
    openSubs('root');
    const out = railHtml([
      tab('root'),
      tab('kid-a', { spawned_by: 'root' }),
      tab('kid-b', { spawned_by: 'root' }),
      tab('kid-c', { spawned_by: 'root' }),
    ]);
    expect(count(out, 'data-child="true"')).toBe(3);
    expect(count(out, 'data-child-last="true"')).toBe(1);
    // …and it is the LAST one, not just any one.
    const last = out.lastIndexOf('data-child-last="true"');
    expect(out.slice(last)).toContain('kid-c');
    expect(out.slice(0, last)).toContain('kid-b');
  });

  it('marks an only child as the last one — a run of one still ends', () => {
    openSubs('root');
    const out = railHtml([tab('root'), tab('kid', { spawned_by: 'root' })]);
    expect(count(out, 'data-child-last="true"')).toBe(1);
  });

  it('marks the last child of EACH family, not of the list', () => {
    // Two parents in one list: a single flag for the whole rail would leave the
    // first family's trunk running on into the second parent's rows.
    openSubs('a', 'b');
    const out = railHtml([
      tab('a'),
      tab('a1', { spawned_by: 'a' }),
      tab('a2', { spawned_by: 'a' }),
      tab('b'),
      tab('b1', { spawned_by: 'b' }),
    ]);
    expect(count(out, 'data-child="true"')).toBe(3);
    expect(count(out, 'data-child-last="true"')).toBe(2);
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

  it('a delivered sub-chat is TWO clicks in, never at the top of the drawer', () => {
    // The archive filled with machine-named work nobody recognised, so the
    // drawer's top level is yours alone. The sub-chats are still there — one
    // disclosure further in, below the chats you archived yourself, shut by
    // default even once the drawer above them is open.
    const box = mountRail([
      tab('root'),
      // No clock at all — a sub-chat does not decay, it delivers (groupChats).
      tab('kid', { spawned_by: 'root', done: true, done_reason: 'delivered', clock: null }),
    ]);
    const heads = () => [...box.querySelectorAll<HTMLButtonElement>('.navtree-done-head')];
    // Shut: ONE line, and it counts the top level — which is empty here, so it
    // reads "0 done". The sub-chat head is not even rendered yet.
    expect(heads()).toHaveLength(1);
    expect(heads()[0]?.textContent).toContain('0 done');
    expect(box.querySelectorAll('[data-shape="dot"]')).toHaveLength(0);

    // One click: the drawer opens onto the nested head, and STILL no sub-chat.
    act(() => heads()[0]?.click());
    expect(heads()).toHaveLength(2);
    expect(heads()[1]?.textContent).toContain('1 sub-agent');
    expect(box.querySelectorAll('[data-shape="dot"]')).toHaveLength(0);

    // Two clicks: now the row, as a hollow dot under a label naming its parent.
    act(() => heads()[1]?.click());
    expect(box.querySelectorAll('.chatchip-dot[data-hollow="true"]')).toHaveLength(1);
    expect(box.querySelectorAll('.navtree-tab-row[data-child="true"]')).toHaveLength(1);
    // The parent is a LABEL — it has a live row of its own above.
    expect(box.querySelector('.navtree-done-parent')?.textContent).toBe('root');
    expect(box.querySelectorAll('.navtree-tab-row')).toHaveLength(2);
  });

  it('singular, because "1 sub-agents" is the kind of thing nobody fixes later', () => {
    const box = mountRail([
      tab('root'),
      tab('a', { spawned_by: 'root', done: true, done_reason: 'delivered', clock: null }),
      tab('b', { spawned_by: 'root', done: true, done_reason: 'delivered', clock: null }),
    ]);
    act(() => box.querySelector<HTMLButtonElement>('.navtree-done-head')?.click());
    expect(
      [...box.querySelectorAll<HTMLButtonElement>('.navtree-done-head')][1]?.textContent,
    ).toContain('2 sub-agents');
  });

  it('a DECAYED top-level chat still fills the drawer', () => {
    // The drawer is not deleted, only narrowed — this is what it is for.
    const box = mountRail([tab('root'), tab('old', { done: true, done_reason: 'decayed' })]);
    expect(box.querySelector('.navtree-done-head')?.textContent).toContain('1 done');
    act(() => box.querySelector<HTMLButtonElement>('.navtree-done-head')?.click());
    expect(box.querySelectorAll('.navtree-tab-row')).toHaveLength(2);
  });

  it('draws a working child as a SOLID dot in the live list', () => {
    // The other half of the two-state vocabulary, and the reason the drawer is
    // not the only place a dot appears.
    openSubs('root');
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

  it('uses the same unread-parent and running-child distinction on the sheet', () => {
    openSubs('root');
    const html = sheetHtml([
      tab('root', { status: 'ready' }),
      tab('child', { spawned_by: 'root', status: 'working', clock: null }),
    ]);
    expect(html).toContain('navtree-mark navtree-rail-mark" data-state="ready"');
    expect(html).toContain('title="Unread reply in this chat"');
    expect(html).toContain('navtree-mark navtree-rail-mark" data-state="working"');
    // …and the pill says what the worker is doing, open or shut (see the rail
    // test of the same case) — in its hue and its tooltip, with the count as
    // the only thing it spends width on.
    expect(html).toContain('navtree-subs-pill');
    expect(html).toMatch(/navtree-subs-pill[^>]*data-state="working"/);
    expect(html).toMatch(/navtree-row-pill-n">1</);
    expect(html).not.toContain('navtree-row-pill-dot');
    expect(html).not.toContain('navtree-row-pill-glyph');
  });

  it('draws it ON THE SHEET TOO — the surface that has nothing else to say it', () => {
    // Reported: "mobile sidebar render doesn't include many recent changes to
    // desktop, for example I don't see pinned chat indicators". It was exactly
    // that — the edge was designed on the desktop row and the sheet row was
    // never given it, the same drift `data-child` had before it.
    //
    // And the sheet needs it MORE: the sidebar ALSO says pinned through its
    // hover-revealed pin button, while a touch row carries no permanent
    // controls at all by design (lib/nav-row-affordances.ts). Position cannot
    // say it either — the pin divider was deleted when this mark arrived.
    const html = sheetHtml([tab('pinned', { pinned: true }), tab('ordinary')]);
    expect(count(html, 'navtree-pin-edge')).toBe(1);
    expect(html).toContain('data-pinned="true"');
  });

  it('marks the child row as a child, so the indent rule can reach it', () => {
    // `data-child` was emitted by the desktop row and not by the sheet's, so
    // even once the grouping arrived a child would have been an ordinary line.
    openSubs('root');
    const out = sheetHtml([tab('root'), tab('kid', { spawned_by: 'root', clock: null })]);
    expect(count(out, 'data-child="true"')).toBe(1);
  });

  it('a MULTI-PANE chat opens with the same pill, a different glyph', () => {
    // The rail has two hierarchies: panes inside a chat, and chats under a
    // chat. Both were bare carets until the sub-chat one became a counted
    // pill, which left this one looking like a bug — "the chat named Main has
    // a caret which you click and you see three things under it but it's
    // rendered differently, what's going on?".
    // Same shape, different noun. The old chevron must not come back.
    const split = {
      direction: 'row',
      first: { direction: 'row', first: 'p1', second: 'p2' },
      second: 'p3',
    } as unknown as Tab['layout'];
    const out = sheetHtml([tab('main', { layout: split })]);
    expect(out).toContain('navtree-row-pill navtree-pane-pill');
    expect(out).not.toContain('navtree-pane-expander');
    // THE COUNT is the gain: how many are under there, before you tap.
    expect(out).toContain('3 panes');
    // …and it is never a status object. The row's own mark one cell along is
    // already saying what the chat is doing.
    expect(out).not.toMatch(/navtree-pane-pill[^>]*data-state=/);
  });

  it('a single-pane chat gets no pill at all — there is nothing to pick', () => {
    const out = sheetHtml([tab('solo')]);
    expect(out).not.toContain('navtree-pane-pill');
  });

  it('…and the DESKTOP rail never draws one: it is a touch control', () => {
    const split = {
      direction: 'row',
      first: 'p1',
      second: 'p2',
    } as unknown as Tab['layout'];
    expect(railHtml([tab('main', { layout: split })])).not.toContain('navtree-pane-pill');
  });

  it('ends the trunk on the last child HERE TOO — this is the surface it broke on', () => {
    // The sheet wraps every row in a `.swiperow`, so the CSS sibling test that
    // used to carry the trunk through could never match here. Three children
    // drew three detached brackets.
    openSubs('root');
    const out = sheetHtml([
      tab('root'),
      tab('k1', { spawned_by: 'root', clock: null }),
      tab('k2', { spawned_by: 'root', clock: null }),
      tab('k3', { spawned_by: 'root', clock: null }),
    ]);
    expect(count(out, 'data-child="true"')).toBe(3);
    expect(count(out, 'data-child-last="true"')).toBe(1);
    expect(out.slice(out.lastIndexOf('data-child-last="true"'))).toContain('k3');
  });

  it('gives the child a dot in the emoji column and the parent the same CHIP the rail draws', () => {
    // The dot is what makes this read as nesting: it stands in the emoji's own
    // fixed box, which lands every child name on one x.
    //
    // THE PARENT'S CELL CONVERGED WITH THE DESKTOP'S, and this assertion is the
    // inverse of what it used to be. It read "no tile is introduced here",
    // because a tile was a plate and the plate is deleted on this surface. A2
    // deletes the plate on the DESKTOP too: what a `tile` is now is a bare glyph
    // on the row's own ground, which is exactly what the sheet already drew — so
    // the two surfaces were one drawing apart and diverging on everything else.
    // With the same component on both, the phone gets the clock it never had
    // (its top-level rows aged invisibly) and cannot drift from the rail again.
    openSubs('root');
    const out = sheetHtml([tab('root'), tab('kid', { spawned_by: 'root', clock: null })]);
    expect(count(out, 'data-shape="dot"')).toBe(1);
    expect(count(out, 'data-shape="tile"')).toBe(1);
    // Same cell, so the sheet's own geometry rules still reach it (the 20px box
    // and the 1px optical lift live on this class — NavTree.spacing.test.ts).
    expect(out).toContain('chatchip navtree-tab-icon');
  });

  it('runs the CLOCK on a top-level sheet row, which it never did before', () => {
    // The whole point of converging: the phone is the device this list is read
    // on, and its rows carried no time at all — a chat one day from leaving the
    // live list looked exactly like one talked to a minute ago.
    const out = sheetHtml([tab('root', { clock: aged(2) }), tab('old', { clock: aged(3) })]);
    expect(out).toContain('data-step="2"');
    expect(out).toContain('data-phase="last-day"');
  });

  it('puts the child AFTER its parent, whatever the flat order says', () => {
    // The reported symptom exactly: recency sorted the fresh sub-chats above the
    // chat that spawned them. Grouping is what makes position mean parentage
    // instead of last-touched, so the child must follow its parent even when the
    // incoming list has it first.
    openSubs('root');
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

/**
 * ─── THE COLLAPSE, AND WHAT IT MUST NOT HIDE ────────────────────────────────
 *
 * A fan-out is the normal shape of work here — 65 children under one chat on
 * this install — and every one of them was a row, so the list of
 * CONVERSATIONS became a list of errands. Shutting them is only safe if the
 * two signals the rows were carrying survive the shut: a worker blocked on a
 * question, and a count you can read without opening anything.
 */
describe('sub-chats are collapsed, and the collapse still tells the truth', () => {
  const family = (over: Partial<Tab>[] = [{}, {}]) => [
    tab('root'),
    ...over.map((o, i) => tab(`kid${i}`, { spawned_by: 'root', clock: null, ...o })),
  ];

  it('draws no child rows by default, and one PILL instead — on the parent row', () => {
    // The chip used to be a line of its own under the parent. It is now one
    // object at the end of the parent's row: "it feels like we're just wasting
    // space now" — four small things and a whole row of a 240px rail for a
    // group that is usually one or two children.
    const out = railHtml(family());
    expect(out).not.toContain('>kid0<');
    expect(out).not.toContain('data-child="true"');
    expect(count(out, 'navtree-row-pill navtree-subs-pill')).toBe(1);
    // …and the row it used to occupy is gone, not merely restyled.
    expect(out).not.toContain('navtree-subs-head');
    // The words survive in the title and the accessible name, which is where
    // they have to live: they do not fit beside a name on a 240px row.
    expect(out).toContain('2 sub-agents');
  });

  it('puts the pill INSIDE the parent’s row, not after it', () => {
    // The whole point. If it rendered as a sibling the row count would not
    // have changed and this would be a restyle of the same layout.
    const out = railHtml(family());
    const row = out.indexOf('navtree-tab-row');
    const pill = out.indexOf('navtree-subs-pill');
    const rowEnd = out.indexOf('navtree-tab-row', row + 1);
    expect(pill).toBeGreaterThan(row);
    expect(pill).toBeLessThan(rowEnd === -1 ? out.length : rowEnd);
  });

  it('the schedule yields to it, and only on a row that has sub-chats', () => {
    // Both will not fit beside a name on a 240px row — measured, the name
    // drops to 55px and `Orbit Builder` truncates. A chat with live workers
    // has more to say than when its cron next fires, and the time stays on the
    // row's title. A chat WITHOUT sub-chats is untouched.
    const crons = [{ name: 'sweep', next_at: NOW + 3_600_000 }] as unknown as Tab['crons'];
    const withSubs = railHtml([
      tab('root', { crons }),
      tab('kid0', { spawned_by: 'root', clock: null }),
    ]);
    expect(withSubs).toContain('navtree-subs-pill');
    expect(withSubs).not.toContain('navtree-cron');
    const without = railHtml([tab('solo', { crons })]);
    expect(without).toContain('navtree-cron');
  });

  it('the PILL is about the workers and the MARK is about the chat', () => {
    // THE BUG THIS REPLACES, caught on the live rail at 03:48. Merging the
    // count and the state into one pill was right; feeding it
    // `rollupStatus(own, children)` was not, because that folds the parent's
    // own state in with its children's. With the chat mid-turn and its one
    // worker finished the pill rendered
    //
    //   data-state="working"   title="1 sub-chat (1 ready)"
    //
    // — the dot about the parent, the words about the child, and nothing to
    // tell a reader which half was which. They are two subjects and they get
    // two objects: the pill answers for the workers, the row's own mark
    // answers for the chat.
    const out = railHtml([
      tab('root', { status: 'working' }),
      tab('kid0', { spawned_by: 'root', status: 'ready', clock: null }),
    ]);
    const pill = /<button[^>]*navtree-subs-pill[^>]*>/.exec(out)?.[0] ?? '';
    expect(pill).toContain('data-state="ready"');
    expect(pill).not.toContain('data-state="working"');
    // …and the parent's own `working` did not vanish with it: the mark is
    // drawn again now, where it was suppressed while the pill carried both.
    expect(out).toContain('navtree-mark');
    expect(out).toContain('data-state="working"');
  });

  it('…so an idle chat with a blocked worker still reaches the glance', () => {
    // The safety argument for collapsing, restated for the new owner of it.
    // The parent is idle and would draw no mark at all, so the pill is the
    // only thing that can say a worker is stopped on a question.
    const out = railHtml([
      tab('root'),
      tab('kid0', { spawned_by: 'root', status: 'blocked', clock: null }),
    ]);
    const pill = /<button[^>]*navtree-subs-pill[^>]*>/.exec(out)?.[0] ?? '';
    expect(pill).toContain('data-state="blocked"');
  });

  it('names the states in the chip, loudest first', () => {
    const out = railHtml(
      family([{ status: 'working' }, { status: 'blocked' }, { status: 'working' }]),
    );
    expect(out).toContain('1 needs you · 2 running');
  });

  it('bubbles a blocked child onto the parent row while shut', () => {
    // The whole safety argument for collapsing. The parent is idle and would
    // normally render NO mark at all (RowMark drops the element), so this is
    // not a tint on an existing dot — it is the difference between the rail
    // showing the blocked worker and not showing it.
    const out = railHtml(family([{ status: 'blocked' }]));
    expect(out).toContain('data-state="blocked"');
  });

  it('keeps the rail moving for a working child, so a still rail still means still', () => {
    const out = railHtml(family([{ status: 'working' }]));
    expect(out).toContain('data-state="working"');
  });

  it('gives the parent its OWN state back once the family is open', () => {
    // Open, the children have rows of their own to carry it on, and a parent
    // wearing a child's state would be reporting the same fact twice.
    openSubs('root');
    const out = railHtml([tab('root'), tab('kid0', { spawned_by: 'root', status: 'blocked' })]);
    // One row MARK, on the child's row. The chip keeps its own `data-state`
    // (it is the control, and it still says "1 needs you" while open), so the
    // count that matters is of marks, not of the attribute.
    expect(count(out, 'navtree-mark" data-state="blocked"')).toBe(1);
    expect(out).toContain('data-child="true"');
  });

  it('draws no chip for a chat with no children at all', () => {
    const out = railHtml([tab('root'), tab('other')]);
    expect(out).not.toContain('navtree-subs-head');
  });

  it('opens the group that holds the chat you are LOOKING at', () => {
    // A shut group containing the active chat leaves the rail with no selected
    // row anywhere — tap a spawn card, or @-jump to a worker, and the sidebar
    // highlights nothing. On the phone the sheet IS the navigation, so that is
    // "where am I?" with no answer.
    const out = railHtml([tab('root'), tab('kid0', { spawned_by: 'root' })], 'kid0');
    expect(out).toContain('data-child="true"');
    expect(out).toContain('>kid0<');
  });

  it('…and shuts it again when you are somewhere else', () => {
    // Not persisted: it is a fact about where you are, not a disclosure you
    // opened. Leaving must not quietly leave the group expanded forever.
    const out = railHtml([tab('root'), tab('kid0', { spawned_by: 'root' })], 'root');
    expect(out).not.toContain('>kid0<');
  });
});

describe('sub-chat status wording', () => {
  const pill = (html: string) =>
    /<button[^>]*navtree-subs-pill[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
  const text = (html: string) => pill(html).replace(/<[^>]+>/g, '');
  /** The sentence lives in the tooltip now — see SubsPill. */
  const spoken = (html: string) => /title="([^"]*)"/.exec(pill(html))?.[1] ?? '';

  // THE LABEL IS THE COUNT; THE SENTENCE IS THE TOOLTIP. It used to be the
  // other way round and the pill measured 91px of a 272px row — a third of it,
  // to say two numbers the hue and the digit already carry. Reported as "all
  // these '1 running', '2 · 1 unread' statuses are odd" and "chat names can
  // get tiny". Nothing is lost: every word below is still spoken, to a
  // pointer and to a screen reader.
  it.each([
    ['idle', '1 sub-agent'],
    ['working', '1 running'],
    ['ready', '1 unread'],
    ['blocked', '1 needs you'],
    ['dead', '1 stopped'],
  ] as const)('names %s hidden children without a status-symbol legend', (status, label) => {
    const html = railHtml([tab('root'), tab('child', { spawned_by: 'root', status, clock: null })]);
    expect(text(html)).toBe('1');
    expect(spoken(html)).toContain(label.replace('1 ', ''));
    expect(pill(html)).not.toContain('navtree-row-pill-dot');
    expect(pill(html)).not.toContain('navtree-row-pill-glyph');
  });

  it('distinguishes an unread parent from its still-running visible child', () => {
    // REPORTED FROM A SCREENSHOT: "this state is a bit odd there's a green
    // checkmark but two sub-agents are working."
    //
    // Both facts were true and only one of them was on the row. The parent's
    // tick is its own unread reply; the workers under it were running; and the
    // pill — the one object on the row that answers for the workers — went
    // quiet the moment the group was expanded, leaving a tick as the only
    // state on a family that was plainly not finished.
    //
    // So the two subjects keep one object each, in both states of the
    // disclosure: the mark is the chat's, the pill is the workers'.
    openSubs('root');
    const html = railHtml([
      tab('root', { status: 'ready' }),
      tab('child', { spawned_by: 'root', status: 'working', clock: null }),
    ]);
    expect(text(html)).toBe('1');
    expect(spoken(html)).toContain('running');
    expect(pill(html)).toContain('data-state="working"');
    expect(html).toContain('title="Unread reply in this chat"');
    expect(html).toMatch(/navtree-mark" data-state="ready"[^>]*>✓<\/span>/);
    expect(html).toContain('navtree-mark" data-state="working"');
  });

  it("keeps the workers' state on the pill whether the group is open or shut", () => {
    // The caret is what says open; the hue is what says what they are doing.
    // Expanding a group must not be a way to lose the second.
    const shut = railHtml([
      tab('root', { status: 'ready' }),
      tab('child', { spawned_by: 'root', status: 'blocked', clock: null }),
    ]);
    openSubs('root');
    const open = railHtml([
      tab('root', { status: 'ready' }),
      tab('child', { spawned_by: 'root', status: 'blocked', clock: null }),
    ]);
    expect(pill(shut)).toContain('data-state="blocked"');
    expect(pill(open)).toContain('data-state="blocked"');
    expect(text(shut)).toBe('1');
    expect(text(open)).toBe('1');
    expect(spoken(shut)).toContain('needs you');
    expect(spoken(open)).toContain('needs you');
  });

  it('retains the total and counts the urgent subset for mixed children', () => {
    const html = railHtml([
      tab('root'),
      tab('one', { spawned_by: 'root', status: 'blocked', clock: null }),
      tab('two', { spawned_by: 'root', status: 'working', clock: null }),
      tab('three', { spawned_by: 'root', status: 'idle', clock: null }),
    ]);
    expect(text(html)).toBe('3');
    expect(spoken(html)).toContain('1 needs you');
    expect(spoken(html)).toContain('1 running');
    expect(spoken(html)).toContain('1 idle');
  });
});

/**
 * THE WORKING SET IS ON BOTH SURFACES.
 *
 * It shipped on the desktop rail only — reported as "I don't see the recent
 * section in sidebar on mobile". The cost of hunting for a chat is HIGHER on
 * a phone: the list is the whole screen and there is no ⌘K chord on a thumb.
 */
describe('the working-set strip reaches the sheet', () => {
  const tsx = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');

  it('is rendered by BOTH the rail and the sheet', () => {
    expect(tsx.match(/<WorkingSetStrip/g) ?? []).toHaveLength(2);
  });

  it('renders INSIDE the scroller on both surfaces, as the first thing in it', () => {
    // It was pinned above the scroller — "a strip you have to scroll to is a
    // strip you will search for" — and that assumed a rail mostly below the
    // fold. It is not: the band is six rows at most and sits at the top, so
    // on any rail taller than about ten rows it is on screen either way. What
    // pinning actually bought was a fixed object the list slid under: "I'm
    // not entirely sold on having the recent chats be fixed. I think you
    // should be able to scroll through the whole thing."
    for (const host of ['function SidebarTree', 'function SheetRail']) {
      const surface = tsx.slice(tsx.indexOf(host));
      const strip = surface.indexOf('<WorkingSetStrip');
      const scroll = surface.indexOf('className="navtree-scroll"');
      expect(strip, host).toBeGreaterThan(-1);
      expect(scroll, host).toBeGreaterThan(-1);
      expect(scroll, host).toBeLessThan(strip);
    }
  });

  it('carries NO standing control on touch, and no slot cap anywhere', () => {
    // Every other row on the sheet follows this (tabRowAffordances): no hover
    // to reveal a control, no Control key to label.
    //
    // The `⌃3` cap is gone from the DESKTOP rows too — six bordered caps down
    // the band fought the status marks for the one column the eye scans
    // ("remove ^1 etc keys"). The shortcut itself is untouched, which is what
    // the `if (touch) return;` guard below still pins.
    expect(tsx).not.toMatch(/navtree-slot-key/);
    expect(readFileSync(join(__dirname, 'NavTree.css'), 'utf8')).not.toMatch(
      /navtree-slot-key\s*\{/,
    );
    expect(tsx).toMatch(/if \(touch\) return;/);
    const css = readFileSync(join(__dirname, 'NavTree.css'), 'utf8');
    expect(css).toMatch(/\[data-touch="true"\] \.navtree-slot-drop \{\s*display: none/);
    // …and it keeps the sheet's 44px touch floor rather than the rail's 34.
    expect(css).toMatch(/\.navtree-ws-slot\[data-touch="true"\] \{\s*height: 44px/);
  });
});

/**
 * THE BAND NAMES THE WORKSPACE, BECAUSE IT IS THE ONLY PLACE THAT HAS TO.
 *
 * Everywhere else in the rail a chat sits under a header that names its
 * workspace. The recently-active band mixes them, and two workspaces on this
 * install have a chat called "Main".
 */
describe('a recently-active row carries its workspace', () => {
  const tsx = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');
  const css = readFileSync(join(__dirname, 'NavTree.css'), 'utf8');
  const row = tsx.slice(tsx.indexOf('function WorkingSetRow'));
  const body = row.slice(0, row.indexOf('\nfunction '));

  it('prints it AFTER the chat name, on the same line', () => {
    // It was a prefix. A rail is scanned down its left edge — the same
    // argument that keeps every status mark on one x — and a leading
    // "Orbit /" pushed that row's NAME 70px right of every other name in the
    // band: the thing you are looking for stopped starting where its
    // neighbours start, to make room for the thing you are not.
    expect(body).toMatch(/navtree-ws-tag[\s\S]{0,120}\{workspace\.name\}/);
    expect(body.indexOf('navtree-name-text')).toBeLessThan(body.indexOf('navtree-ws-tag'));
    // A second line would break the band's rows off the tree's grid, and a
    // chip would take width from the status column.
    expect(body).not.toMatch(/navtree-ws-prefix/);
  });

  it('is the part that gives way when the rail is narrow', () => {
    // You are looking for the chat; the workspace only disambiguates it.
    expect(rule(css, '.navtree-ws-tag')).toMatch(/flex:\s*0 1 auto/);
    expect(rule(css, '.navtree-ws-tag')).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(css, '.navtree-ws-slot .navtree-name-text')).toMatch(/flex:\s*0 1 auto/);
  });

  it('sits on the name’s baseline, not in the middle of its own box', () => {
    // The title line is `align-items: center`, which centres each item's BOX —
    // and two font sizes then have two baselines, the smaller one lower. The
    // tag read as sagging below the name it qualifies.
    const line = rule(css, '.navtree-ws-slot .navtree-tab-titleline');
    expect(line).toMatch(/align-items:\s*baseline/);
  });

  it('steps up on hover, which is when you are asking the question', () => {
    // Matched on the text rather than through `rule()`, because the selector
    // shares its block with the focus-visible arm.
    const i = css.indexOf('.navtree-tab-row:hover .navtree-ws-tag');
    expect(i, 'no hover rule for the tag').toBeGreaterThan(-1);
    expect(css.slice(i, css.indexOf('}', i))).toMatch(/color:\s*var\(--nt-ws-tag-ink-hot\)/);
    // …and the resting ink is the fainter of the two, or the hover says
    // nothing.
    expect(css).toMatch(/--nt-ws-tag-ink:\s*color-mix\(in srgb, var\(--fg-faint\)/);
    expect(css).toMatch(/--nt-ws-tag-ink-hot:\s*var\(--nt-ink-read\)/);
  });

  it('keeps every re-derivation of the token in step', () => {
    // The token is re-stated wherever the palette changes surface (the
    // selected row, the sheet). A definition left behind is a tag that goes
    // on wearing the old ink on exactly one kind of row.
    const rest = (css.match(/--nt-ws-tag-ink:/g) ?? []).length;
    const hot = (css.match(/--nt-ws-tag-ink-hot:/g) ?? []).length;
    expect(hot).toBe(rest);
  });

  it('is quieter by ink and size, never by weight', () => {
    // At 13px a lighter weight is just blur.
    const tag = rule(css, '.navtree-ws-tag');
    // Its own ink, a step below the dim the read rows wear — it is the least
    // important thing on a line whose names it must not compete with.
    expect(tag).toMatch(/color:\s*var\(--nt-ws-tag-ink\)/);
    expect(css).toMatch(/--nt-ws-tag-ink:/);
    // …and smaller than the name beside it, which is 0.9375rem.
    const size = /font-size:\s*([\d.]+)rem/.exec(tag)?.[1];
    expect(Number(size)).toBeLessThan(0.75);
    expect(tag).not.toMatch(/font-weight:/);
  });

  it('is not read twice — the link’s title already says the pair', () => {
    expect(body).toMatch(/aria-hidden="true">\s*\{workspace\.name\}/);
    expect(body).toMatch(/title=\{`\$\{tab\.name\} · \$\{workspace\.name\}`\}/);
  });
});

/**
 * The body of one rule, found by its selector.
 *
 * ANCHORED TO A RULE START, which is the whole correctness of it: a plain
 * `indexOf('.navtree-ws-tag {')` also matches INSIDE
 * `.navtree-ws-slot .navtree-ws-tag {`, so adding a scoped override silently
 * redirected four assertions to the wrong block and they failed describing
 * the wrong rule. (The card tests were fixed for exactly this a few hours
 * earlier; the same helper existed here and was not.)
 */
function rule(css: string, sel: string): string {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = new RegExp(`(^|[}\\n])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const m = at.exec(flat);
  if (!m) return '';
  const i = m.index + m[0].length - 1;
  return flat.slice(i, flat.indexOf('}', i));
}

/**
 * AND IT IS ON EVERY ROW.
 *
 * It rendered only when the chat was from ANOTHER workspace, on the argument
 * that five identical "Personal" tags down a six-row band is repetition
 * rather than information. That is true of the TAG and false of the BAND: a
 * column present on some rows and absent on others is one you cannot scan,
 * and a reader who has learned that a bare row means "here" has learned a
 * rule instead of reading a label. Repetition in a column is what a column
 * IS.
 */
describe('every row says where it is from', () => {
  const src = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');
  const row = src.slice(src.indexOf('function WorkingSetRow'));
  const body = row.slice(0, row.indexOf('\nfunction '));

  it('renders the tag unconditionally', () => {
    expect(body).toMatch(/<span className="navtree-ws-tag" aria-hidden="true">/);
    expect(body).not.toMatch(/elsewhere/);
  });

  it('needs no idea of which workspace you are in', () => {
    // The strip took `activeWorkspaceSlug` for exactly one reason — deciding
    // whether a row was "elsewhere" — so it goes with the condition.
    const strip = src.slice(src.indexOf('function WorkingSetStrip'));
    expect(strip.slice(0, strip.indexOf('\nfunction '))).not.toMatch(/activeWorkspaceSlug/);
  });
});

/**
 * ── HOW LONG AGO ─────────────────────────────────────────────────────────
 *
 * The band is ordered by SLOT and never by recency — that is the whole design,
 * so rows do not move under you — and the cost is that nothing said whether
 * you left a chat ten minutes ago or this morning. This column is what the
 * ordering gives up, handed back.
 */
describe('a recently-active row says how long ago', () => {
  const tsx = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');
  const css = readFileSync(join(__dirname, 'NavTree.css'), 'utf8');
  // The STRIP holds the clock and passes the age down, so both halves are in
  // scope here rather than just the row.
  const strip = tsx.slice(tsx.indexOf('function WorkingSetStrip'));
  const body = strip.slice(0, strip.indexOf('\nfunction SidebarTree'));

  it('reads the SAME stamp the slot decays on', () => {
    // The number on screen and the rule that evicts the row have to be one
    // clock, or a row can read "2m" and vanish.
    expect(body).toMatch(/age=\{now - at\}/);
    expect(body).toMatch(/rows\.map\(\(\{ tab, workspace, at \}\)/);
  });

  it('ticks on its own rather than waiting for something else to render', () => {
    expect(body).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 30_000\)/);
  });

  it('is quieter than the workspace tag, which is already the quiet thing', () => {
    // The tag answers "which chat is this"; the age answers "how stale". Only
    // the first is ever what you are scanning for.
    const age = rule(css, '.navtree-slot-age');
    expect(age).toMatch(/color:\s*color-mix\(in srgb, var\(--band-ink-dim\)/);
    const tagSize = /font-size:\s*([\d.]+)rem/.exec(rule(css, '.navtree-ws-tag'))?.[1];
    const ageSize = /font-size:\s*([\d.]+)rem/.exec(age)?.[1];
    expect(Number(ageSize)).toBeLessThan(Number(tagSize));
  });

  it('does not jitter as the numbers tick', () => {
    expect(rule(css, '.navtree-slot-age')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('lives on the TITLE LINE, not as a fifth track of a four-track grid', () => {
    // It was a sibling of the row, which has four columns — so it wrapped,
    // every row grew a second line, and the status mark (the tick, the
    // chevron) went down with it.
    const line = body.slice(body.indexOf('navtree-tab-titleline'));
    const i = line.indexOf('navtree-slot-age');
    expect(i, 'the age is not on the title line').toBeGreaterThan(-1);
    expect(i, 'it must come after the workspace tag').toBeGreaterThan(
      line.indexOf('navtree-ws-tag'),
    );
  });

  it('never shrinks — the tag gives way first', () => {
    // A clipped "Orb…" still reads; a clipped "3…" does not.
    expect(rule(css, '.navtree-slot-age')).toMatch(/flex:\s*0 0 auto/);
    expect(rule(css, '.navtree-ws-tag')).toMatch(/flex:\s*0 1 auto/);
  });

  it('does not disappear on the one row you are pointing at', () => {
    expect(css).not.toMatch(
      /\.navtree-ws-slot:hover \.navtree-slot-age[^{]*\{[^}]*display:\s*none/,
    );
  });
});

/**
 * ── THE HELPER THAT READS A RULE ─────────────────────────────────────────
 *
 * It matched a selector anywhere, so `.navtree-ws-tag` also found
 * `.navtree-ws-slot .navtree-ws-tag` — and the moment a scoped override was
 * added, four assertions quietly started describing the wrong block. They
 * failed, which was luck: the same mistake can just as easily pass.
 */
describe('rule() finds the rule it was asked for', () => {
  const css = [
    '.a .target { color: red; }',
    '.target { color: green; }',
    '.target .b { color: blue; }',
  ].join('\n');

  it('does not match a selector used as a DESCENDANT', () => {
    expect(rule(css, '.target')).toContain('green');
  });

  it('returns empty for a selector that is not a rule of its own', () => {
    expect(rule(css, '.nothing-here')).toBe('');
  });
});
