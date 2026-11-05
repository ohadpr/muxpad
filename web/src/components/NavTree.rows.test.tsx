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
  it('draws no row for a spawned chat, on the rail', () => {
    const html = railHtml([tab('parent'), tab('kid', { spawned_by: 'parent' })]);
    expect(html).toContain('parent');
    expect(html).not.toContain('kid');
  });

  it('draws no row for a spawned chat on the sheet either', () => {
    TABS = [tab('parent'), tab('kid', { spawned_by: 'parent' })];
    const html = renderToStaticMarkup(
      <TabList
        workspace={WS}
        isActiveWorkspace={true}
        activeTabSlug={null}
        variant="sheet"
        editing={null}
        setEditing={() => {}}
      />,
    );
    expect(html).toContain('parent');
    expect(html).not.toContain('kid');
  });

  it('STILL draws one when the chat has no home to be found in', () => {
    // A chat is never invisible because of a pointer. Its parent is in another
    // workspace or gone, so there is no drawer it would be listed in — it is a
    // conversation in its own right and gets a row. See `groupChats`.
    const html = railHtml([tab('here'), tab('orphan', { spawned_by: 'elsewhere' })]);
    expect(html).toContain('orphan');
  });

  it('…and when its parent retired out from under it while it was working', () => {
    // The same rule from the other direction: the parent is in the done list,
    // two clicks away, so a worker still running would be unreachable.
    const html = railHtml([
      tab('old', { clock: aged(9), done: true }),
      tab('kid', { spawned_by: 'old', clock: null, done: false }),
    ]);
    expect(html).toContain('kid');
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
describe('the sheet’s rows, and the pane pill that belongs to them', () => {
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
    // "OLDER", not "done": a chat leaves the live list when its clock runs
    // out, which is a fact about when it was last used rather than about
    // whether it finished. "82 done" read as a pile of completed work.
    const out = sheetHtml([tab('root'), tab('old', { done: true })]);
    expect(out).toContain('1 older');
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
 * THE WORKING SET IS ON BOTH SURFACES, AT THE TOP OF THE LIST.
 *
 * Fourth arrangement. It was pinned above the rail's scroller, then inside
 * it, then out of the rail altogether and into a tab strip above the pane —
 * on the reasoning that a list which looks like the list under it and means
 * something different reads as noise however carefully it is coloured.
 *
 * True about the band, and not an argument for a second navigation surface:
 * the rail already lists those chats, in groups, with their state, so the
 * strip was a second place to click the same thing and cost a row of the
 * pane's height to be it. "Rethink tab bar — remove it and bring back the
 * recent chats section at the top of the sidebar."
 *
 * Both surfaces render it inside their own scroller now, which is where the
 * sheet has had it all along.
 */
describe('the working-set strip is at the top of both lists', () => {
  const tsx = readFileSync(join(__dirname, 'NavTree.tsx'), 'utf8');

  it('is rendered by the rail AND the sheet', () => {
    expect(tsx.match(/<WorkingSetStrip/g) ?? []).toHaveLength(2);
  });

  it('renders INSIDE each scroller, as the first thing in it', () => {
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

/**
 * ── WHERE CONTAINMENT MAY GO ─────────────────────────────────────────────
 *
 * `container-type: inline-size` computes the element's width WITHOUT looking
 * at its contents. Putting it on a flex item whose width comes from its
 * contents collapses it to zero — which is what happened: every chat name in
 * the band vanished.
 */
describe('the band’s query container', () => {
  const css = readFileSync(join(__dirname, 'NavTree.css'), 'utf8');

  it('is not on the content-sized title line', () => {
    expect(rule(css, '.navtree-ws-slot .navtree-tab-titleline')).not.toContain('container-type');
  });

  it('is on the LINK, whose width the grid hands it', () => {
    // `minmax(0, 1fr)`: the track decides, so containment costs nothing and
    // the query asks about the same space either way.
    expect(
      rule(css, '.navtree[data-variant="sidebar"] .navtree-ws-slot .navtree-tab-link'),
    ).toMatch(/container-type:\s*inline-size/);
  });

  it('is scoped to the RAIL, where the link is a grid item', () => {
    // On the sheet the row is a flex line and the link is `flex: 0 1 auto` —
    // sized BY its contents — so containment collapsed it to zero and every
    // chat name in the mobile band disappeared. Same mistake, one surface
    // along.
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = flat.indexOf('container-type: inline-size');
    const line = flat.lastIndexOf('{', i);
    const selector = flat.slice(flat.lastIndexOf('}', line) + 1, line);
    expect(selector).toContain('[data-variant="sidebar"]');
    // …and the sheet's own link rule is still content-sized, which is why.
    expect(rule(css, '.navtree[data-variant="sheet"] .navtree-tab-link')).toMatch(
      /flex:\s*0 1 auto/,
    );
  });
});

/**
 * "How long ago was this active" is a question about a chat you are NOT in.
 * On the active row the answer is "you are looking at it" — and that row
 * carries the live mark and the heaviest type, so it was the first to clip.
 */
describe('the age is not on the row you are in', () => {
  const css = readFileSync(join(__dirname, 'NavTree.css'), 'utf8');

  it('hides on the active band row', () => {
    expect(
      rule(css, '.navtree-workingset .navtree-tab-row[data-active="true"] .navtree-slot-age'),
    ).toMatch(/display:\s*none/);
  });

  it('and nowhere else — every other row still says when', () => {
    expect(rule(css, '.navtree-slot-age')).not.toMatch(/display:\s*none/);
  });
});
