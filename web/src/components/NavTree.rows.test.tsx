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
    expect(heads()[1]?.textContent).toContain('1 sub-chat');
    expect(box.querySelectorAll('[data-shape="dot"]')).toHaveLength(0);

    // Two clicks: now the row, as a hollow dot under a label naming its parent.
    act(() => heads()[1]?.click());
    expect(box.querySelectorAll('.chatchip-dot[data-hollow="true"]')).toHaveLength(1);
    expect(box.querySelectorAll('.navtree-tab-row[data-child="true"]')).toHaveLength(1);
    // The parent is a LABEL — it has a live row of its own above.
    expect(box.querySelector('.navtree-done-parent')?.textContent).toBe('root');
    expect(box.querySelectorAll('.navtree-tab-row')).toHaveLength(2);
  });

  it('singular, because "1 sub-chats" is the kind of thing nobody fixes later', () => {
    const box = mountRail([
      tab('root'),
      tab('a', { spawned_by: 'root', done: true, done_reason: 'delivered', clock: null }),
      tab('b', { spawned_by: 'root', done: true, done_reason: 'delivered', clock: null }),
    ]);
    act(() => box.querySelector<HTMLButtonElement>('.navtree-done-head')?.click());
    expect(
      [...box.querySelectorAll<HTMLButtonElement>('.navtree-done-head')][1]?.textContent,
    ).toContain('2 sub-chats');
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
    expect(out).toContain('2 sub-chats');
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
    // drops to 55px and `Trayo Builder` truncates. A chat with live workers
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
