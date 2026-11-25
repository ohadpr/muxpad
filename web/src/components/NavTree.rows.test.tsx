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

afterEach(() => localStorage.clear());

/** A clock `days` old, built by the SERVER's own deriver rather than by hand, so
 *  a change to the decay curve reaches these rows instead of a stale copy. */
const aged = (days: number) =>
  chatClock({ started_at: NOW - days * 86_400_000, now: NOW, pinned: false });

/**
 * ─── NO SUB-CHAT IS A ROW IN THIS RAIL ──────────────────────────────────────
 *
 * The rule four earlier describes in this file were about the opposite of. A
 * chat's workers are listed in that chat's own work drawer now, beside the
 * conversation that started them; the rail is a list of conversations.
 *
 * Asserted on BOTH surfaces, because the reason the nesting was hard to get
 * right in the first place is that the rail and the phone sheet render from
 * the same grouping through different components — and the last two bugs here
 * were each present on exactly one of them.
 */
describe('the rail lists conversations, not workers', () => {
  it('STILL draws one when the chat has no home to be found in', () => {
    // A chat is never invisible because of a pointer. Its parent is in another
    // workspace or gone, so there is no drawer it would be listed in — it is a
    // conversation in its own right and gets a row. See `groupChats`.
    const html = railHtml([tab('here'), tab('orphan', { spawned_by: 'elsewhere' })]);
    expect(html).toContain('orphan');
  });

  it('…but NOT when its parent is merely done — the drawer still holds it', () => {
    // The near-miss, and the one this rule used to get wrong. A parent in the
    // done list is still ON the rail and still openable, and its work drawer
    // still lists this child. So the child is two clicks away, not invisible,
    // and it does not need a row of its own.
    //
    // That is the whole difference from the case above: there, the pointer
    // resolves to nothing and there IS no drawer; here it resolves fine.
    const html = railHtml([
      tab('old', { clock: aged(9), done: true }),
      tab('kid', { spawned_by: 'old', clock: null, done: false }),
    ]);
    expect(html).toContain('old');
    expect(html).not.toContain('kid');
  });
});

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
/**
 * THE SHEET'S ROWS — and it no longer nests anything.
 *
 * Five tests here described a child row on the phone: its marker class, the
 * trunk ending on the last of a run, the dot in the emoji column, and the
 * child following its parent whatever the flat order said. Every one of them
 * was about sub-chats being rows in this list, which they are not — a chat's
 * workers are in that chat's work drawer (see `groupChats`). They were deleted
 * with the behaviour rather than loosened to pass, and the rule that replaces
 * them is asserted once, below.
 */
describe('the sheet’s rows', () => {
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

  it('carries the working weight on the sheet, which is a SECOND copy of it', () => {
    // The sidebar and the sheet are different functions with their own copy
    // of the row's attributes — that duplication is exactly how the mobile
    // rail fell behind the desktop one before. The working-weight tests only
    // ever rendered the SIDEBAR, so the sheet's copy was never executed.
    const html = sheetHtml([tab('busy', { status: 'working' } as Partial<Tab>)]);
    expect(html).toContain('data-working="true"');
  });

  it('leaves the sheet row you are on alone, like the sidebar does', () => {
    TABS = [tab('busy', { status: 'working' } as Partial<Tab>)];
    const html = renderToStaticMarkup(
      <TabList
        workspace={WS}
        isActiveWorkspace={true}
        activeTabSlug="busy"
        variant="sheet"
        editing={null}
        setEditing={() => {}}
      />,
    );
    expect(html).not.toContain('data-working="true"');
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

  it('an old SPLIT row gets no pane pill either — a row holds one thing', () => {
    // The pill opened a list of the panes under a chat. There is no such list
    // any more (the server refuses the second pane), so even a row left over
    // from before migration 54 opens like every other row.
    const split = {
      direction: 'row',
      first: { direction: 'row', first: 'p1', second: 'p2' },
      second: 'p3',
    } as unknown as Tab['layout'];
    const out = sheetHtml([tab('main', { layout: split })]);
    expect(out).not.toContain('navtree-pane-pill');
    expect(out).not.toContain('navtree-pane-list');
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

  it('runs the CLOCK on a top-level sheet row, which it never did before', () => {
    // The whole point of converging: the phone is the device this list is read
    // on, and its rows carried no time at all — a chat one day from leaving the
    // live list looked exactly like one talked to a minute ago.
    const out = sheetHtml([tab('root', { clock: aged(2) }), tab('old', { clock: aged(3) })]);
    expect(out).toContain('data-step="2"');
    expect(out).toContain('data-phase="last-day"');
  });

  it('moves a decayed chat into the older drawer instead of leaving it live', () => {
    // The drawer was `[]` on this variant, so a chat the server had already
    // marked done stayed in the live list forever. The header is the shared one.
    //
    // "older chats", with NO number: a chat leaves the live list when its
    // clock runs out, which is a fact about when it was last used rather than
    // about whether it finished — and a count of the thing you are least
    // interested in, at the top of the thing you are most interested in, only
    // ever grows. The header is a door.
    const out = sheetHtml([tab('root'), tab('old', { done: true })]);
    expect(out).toContain('older chats');
    // Collapsed by default here too, so the decayed row is not in the markup.
    expect(out).not.toContain('>old<');
  });

  it('leaves a flat list flat — no marks, no drawer', () => {
    // Guards the four above: they must be reporting the hierarchy, not a
    // grouping pass that decorates every row it touches.
    const out = sheetHtml([tab('root'), tab('other')]);
    expect(out).not.toContain('data-child="true"');
    expect(out).not.toContain('data-shape="dot"');
    expect(out).not.toContain('older');
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

/**
 * ── A CHAT THAT IS STILL GOING KEEPS THE WEIGHT ──────────────────────────
 *
 * Bold answers one question down a long sidebar: which of these rows has
 * something for me. A turn that just finished answers it; so does a turn
 * still running. Before this, a working chat sat at reading weight and was
 * indistinguishable at a glance from forty idle ones — "active chats should
 * retain the 'unread' treatment, it's a good indicator".
 */
describe('a working chat carries the unread weight', () => {
  it('marks a chat whose agent is mid-turn', () => {
    const html = railHtml([tab('busy', { status: 'working' } as Partial<Tab>)]);
    expect(html).toContain('data-working="true"');
  });

  it('does not mark the chat you are already looking at', () => {
    // Bold means "come back to this". You are here.
    const html = railHtml([tab('busy', { status: 'working' } as Partial<Tab>)], 'busy');
    expect(html).not.toContain('data-working="true"');
    expect(html).toContain('data-active="true"');
  });

  it('leaves every other state at reading weight', () => {
    for (const status of ['idle', 'ready', 'dead', undefined])
      expect(railHtml([tab('t', { status } as Partial<Tab>)]), String(status)).not.toContain(
        'data-working="true"',
      );
  });

  it('shares the unread rule rather than inventing a second weight', () => {
    // The gap a DOM-only test leaves: the attribute can render correctly and
    // style nothing. Both surfaces have their own weight rule, and the sheet
    // one was already a separate block — so both are checked.
    const css = readFileSync(join(__dirname, 'NavTree.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    // EXACT SELECTORS, not substrings, and not line anchors.
    //
    // A bare `includes` of the sidebar selector also matches inside the
    // sheet's, so deleting the sidebar rule left this test green — which it
    // did, on the first attempt. The fix for that was a `^...$/m` anchor,
    // which traded one wrong answer for another: it also asserts the
    // FORMATTING, and biome wraps a long selector across lines. That made the
    // repo's own formatter and this test contradict each other, and CI's lint
    // job was the thing that lost — red for days, on a disagreement about
    // where a newline goes.
    //
    // So: split every rule's selector list, normalise whitespace, and ask for
    // exact membership. Substrings cannot pass, and neither can a deletion.
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) =>
      (m[1] as string).split(',').map((sel) => sel.replace(/\s+/g, ' ').trim()),
    );
    for (const [label, sel] of [
      ['sidebar', '.navtree-tab-row[data-working="true"] .navtree-name-text'],
      [
        'sheet',
        '.navtree[data-variant="sheet"] .navtree-tab-row[data-working="true"] .navtree-name-text',
      ],
    ] as const)
      expect(selectors, label).toContain(sel);
  });

  it('is independent of the unread mark — a row can be both', () => {
    const html = railHtml([tab('busy', { status: 'working', unread: true } as Partial<Tab>)]);
    expect(html).toContain('data-working="true"');
    expect(html).toContain('data-unread="true"');
  });
});
