import type { Tab, Workspace } from '@muxpad/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHERE A NEW CHAT GOES, AND WHO SAID SO.
 *
 * ON THE WORKSPACE'S OWN HEADER ROW, and that is the whole answer — the
 * destination is the row the button is drawn on, so nothing asks and nothing
 * needs a label. One `+` per workspace, present whether the workspace is open or
 * shut, and creating in a shut one opens it on the way through.
 *
 * It took three arrangements to get here and each failed differently, which is
 * why they are all pinned below:
 *
 *   a row at the BOTTOM of each workspace's list — scrolled out of reach in a
 *     workspace with twenty chats;
 *   ONE button at the top of the whole rail, with a workspace picker — read as
 *     bolted on, and picking a workspace did not reliably leave you in the chat
 *     it had just made;
 *   a row at the TOP of each list — reachable, but still a row, and the list is
 *     for chats.
 *
 * Nothing here is conditional on a VIEW any more. The flat cross-workspace list
 * is gone, so there is one list on each surface and one place to create in it.
 *
 * Mocks are the ambient four (router, tab cache, workspace cache, all-tabs)
 * plus `api`, which is the thing being asserted: `createTab(workspaceId, …)`.
 * The components under test are the real ones.
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;

function tab(id: string): Tab {
  return {
    id,
    name: id,
    slug: id,
    created_at: NOW,
    updated_at: NOW,
    layout: { type: 'pane', id: `${id}-p` },
    done: false,
  } as unknown as Tab;
}

const CORPUS = [
  { id: 'w-personal', slug: 'personal', name: 'Personal', tabs: [tab('p1')] },
  { id: 'w-acme', slug: 'acme', name: 'Acme', tabs: [tab('t1')] },
  { id: 'w-bots', slug: 'bots', name: 'Acmebot', tabs: [tab('b1')] },
];
const WORKSPACES = CORPUS.map(
  (g) => ({ id: g.id, slug: g.slug, name: g.name, created_at: NOW, updated_at: NOW }) as Workspace,
);

/** Every `api.createTab` this render made, in order. */
let CREATED: { workspaceId: string; body: Record<string, unknown> }[] = [];
/** How many workspaces were created. */
let MADE_WORKSPACES = 0;
/** Every route the surface navigated to. */
let WENT: { wsSlug: string; tabSlug?: string }[] = [];

vi.mock('@tanstack/react-router', () => ({
  // `title` and `onDoubleClick` are forwarded because the rename affordance
  // lives on them: a stub that drops them makes a missing rename look exactly
  // like a present one.
  Link: ({
    children,
    className,
    title,
    onDoubleClick,
  }: {
    children?: ReactNode;
    className?: string;
    title?: string;
    onDoubleClick?: (e: unknown) => void;
  }) => (
    <span className={className} title={title} onDoubleClick={onDoubleClick}>
      {children}
    </span>
  ),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/w/w1/t/a' } }),
  useNavigate: () => (opts: { params: { wsSlug: string; tabSlug?: string } }) => {
    WENT.push(opts.params);
  },
}));

vi.mock('../api', () => ({
  api: {
    createTab: async (workspaceId: string, body: Record<string, unknown>) => {
      CREATED.push({ workspaceId, body });
      return { ...tab('new'), slug: 'new-chat' };
    },
    createWorkspace: async () => {
      MADE_WORKSPACES += 1;
      return WORKSPACES[0];
    },
    patchWorkspace: async () => {},
    deleteWorkspace: async () => {},
    reorderWorkspaces: async () => {},
    reorderTabs: async () => {},
  },
}));

vi.mock('../tabs', () => ({
  useTabs: (wsId: string) => ({
    tabs: CORPUS.find((g) => g.id === wsId)?.tabs ?? [],
    refresh: async () => {},
  }),
  cachedTabsFor: (wsId: string) => CORPUS.find((g) => g.id === wsId)?.tabs ?? [],
  refreshTabs: async () => {},
  // On the create path: the new tab is spliced into the cache before the
  // navigation, or TabView bounces out of the chat it just made.
  insertTabRow: () => {},
  applyTabOrder: () => {},
  applyTabUnread: () => {},
}));

vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: WORKSPACES, refresh: async () => [] }),
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
const { HOUSE_CHAT_CREATE } = await import('../lib/agent-backend');

type Variant = 'sidebar' | 'sheet';

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount(variant: Variant): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<NavTree activeWorkspaceSlug="personal" activeTabSlug="p1" variant={variant} />);
  });
  return host;
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The picker's rows, by the name they show. */
function pickerRow(box: HTMLElement, name: string): Element | undefined {
  return [...box.querySelectorAll('.navtree-wspick-name')].find((b) =>
    (b.textContent ?? '').includes(name),
  );
}

beforeEach(() => {
  CREATED = [];
  WENT = [];
  MADE_WORKSPACES = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('the rail — one “+” per workspace, on its header', () => {
  it('puts one on EVERY workspace, open or shut, and none anywhere else', () => {
    const box = mount('sidebar');
    expect(box.querySelectorAll('.navtree-ws-row').length).toBe(3);
    // One per workspace — including the two that are collapsed. The old
    // arrangements lived inside the tab LIST, which only an expanded workspace
    // renders, so two of three workspaces had no way to create in them at all
    // without first opening them.
    expect(box.querySelectorAll('.navtree-ws-add').length).toBe(3);
    // And nothing left over from the arrangements this replaces.
    expect(box.querySelectorAll('.navtree-new-tab').length).toBe(0);
    expect(box.querySelectorAll('.navtree-add-ws').length).toBe(0);
  });

  it('creates in ITS OWN workspace and goes there, asking nothing', async () => {
    const box = mount('sidebar');
    await click(box.querySelector('.navtree-ws-add'));
    expect(CREATED).toEqual([{ workspaceId: 'w-personal', body: { ...HOUSE_CHAT_CREATE } }]);
    // THE BUG THAT ENDED THE PICKER: "picking a workspace leaves me on my
    // current tab". One click, and the navigation is to the new chat.
    expect(WENT).toEqual([{ wsSlug: 'personal', tabSlug: 'new-chat' }]);
    // No picker was ever shown.
    expect(box.querySelectorAll('.navtree-wspick-name').length).toBe(0);
  });

  it('creates in a workspace you are NOT in, from its own row', async () => {
    const box = mount('sidebar');
    const rows = [...box.querySelectorAll('.navtree-ws-row')];
    const bots = rows.find((r) => (r.textContent ?? '').includes('Acmebot'));
    await click(bots?.querySelector('.navtree-ws-add'));
    expect(CREATED).toEqual([{ workspaceId: 'w-bots', body: { ...HOUSE_CHAT_CREATE } }]);
    expect(WENT).toEqual([{ wsSlug: 'bots', tabSlug: 'new-chat' }]);
  });

  it('does not navigate or toggle when the “+” is clicked', async () => {
    // The header row's own click handler collapses/expands the workspace, and
    // the whole row is a link. A `+` that also did either would be two actions
    // for one click.
    const box = mount('sidebar');
    const before = box.querySelectorAll('.navtree-tab-row').length;
    await click(box.querySelector('.navtree-ws-add'));
    // The active workspace was expanded and stays expanded — its chats are
    // still listed, plus the one just created.
    expect(box.querySelectorAll('.navtree-tab-row').length).toBeGreaterThanOrEqual(before);
  });
});

describe('the flat “Recent” view is gone, and so is the sheet’s picker', () => {
  it('renders no switch at all over the list — the destination rail chooses its view', () => {
    const box = mount('sidebar');
    expect(box.querySelectorAll('.navtree-viewswitch').length).toBe(0);
    expect(box.querySelectorAll('.rail-views').length).toBe(0);
    // …and every workspace is a section of it.
    expect(box.querySelectorAll('.navtree-ws-row').length).toBe(3);
  });

  it('shows EVERY workspace on the sheet, with no picker to go through', () => {
    // The sheet used to render ONE workspace's list and reach the others by
    // swapping the whole list for a picker — a mode change you had to remember
    // you were in. Reported as "clicking in and out of the workspace name".
    const box = mount('sheet');
    const names = [...box.querySelectorAll('.navtree-ws-row .navtree-name-text')].map((e) =>
      (e.textContent ?? '').trim(),
    );
    expect(names).toEqual(['Personal', 'Acme', 'Acmebot']);
    // …and the bar's workspace button is gone with it.
    expect(box.querySelectorAll('.navtree-bar-ws').length).toBe(0);
    expect(box.querySelectorAll('.navtree-wspick-name').length).toBe(0);
  });
});

describe('the sheet creates from a workspace header, like the rail', () => {
  it('gives every workspace its own “+”, and the bar none', () => {
    const box = mount('sheet');
    // One per workspace — the bar cannot carry one, because it no longer names
    // a workspace to create in.
    expect(box.querySelectorAll('.navtree-ws-add').length).toBe(3);
    expect(box.querySelectorAll('[aria-label="New chat"]').length).toBe(0);
  });

  it('creates in the workspace whose “+” was tapped', async () => {
    const box = mount('sheet');
    const rows = [...box.querySelectorAll('.navtree-ws-row')];
    const bots = rows.find((r) => (r.textContent ?? '').includes('Acmebot'));
    await click(bots?.querySelector('.navtree-ws-add'));
    expect(CREATED).toEqual([{ workspaceId: 'w-bots', body: { ...HOUSE_CHAT_CREATE } }]);
    expect(WENT).toEqual([{ wsSlug: 'bots', tabSlug: 'new-chat' }]);
  });
});

/**
 * A NEW WORKSPACE IS A WORKSPACE, not a workspace and a chat.
 *
 * "Creating new workspace extremely slow and force creates new chat not needed
 * ideally" — and both halves of that were the same line. It created a HOUSE
 * CHAT: a tab, a pane, and an agent runner spawning a process. Measured
 * against the live server, 92 ms to create the workspace and 422 ms to create
 * the chat — four fifths of the wait, for something nobody asked for.
 *
 * The empty workspace is a real destination: `/w/$wsSlug` draws "… has no tabs
 * yet" with "+ New tab" and "or close this workspace", so it offers both the
 * next step and the undo.
 */
describe('+ New workspace', () => {
  it('creates the workspace and nothing else', async () => {
    const box = mount('sidebar');
    await click(box.querySelector('.navtree-new-workspace'));
    expect(MADE_WORKSPACES).toBe(1);
    // The expensive half, and the one that was never asked for.
    expect(CREATED).toEqual([]);
  });

  it('lands you in it, not in a chat it invented', async () => {
    const box = mount('sidebar');
    await click(box.querySelector('.navtree-new-workspace'));
    expect(WENT).toEqual([{ wsSlug: WORKSPACES[0]?.slug }]);
    expect(WENT[0]).not.toHaveProperty('tabSlug');
  });

  it('leaves the workspace header’s own “+” making a chat, which is where that belongs', async () => {
    const box = mount('sidebar');
    await click(box.querySelector('.navtree-ws-add'));
    expect(CREATED).toEqual([{ workspaceId: 'w-personal', body: { ...HOUSE_CHAT_CREATE } }]);
  });
});

/**
 * "There's no way to rename workspaces." There was — double-click — but only
 * on the ACTIVE row, so you had to already be inside the workspace you wanted
 * to rename, and the only hint was a tooltip. The restriction existed to avoid
 * "navigate then edit" on an inactive row, and a plain left-click stopped
 * navigating when it became the collapse gesture.
 */
describe('renaming a workspace', () => {
  const dblclick = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
  };
  const editorIn = (box: HTMLElement) => box.querySelector('.navtree-ws-row input');

  it('opens on the active workspace', async () => {
    const box = mount('sidebar');
    const active = [...box.querySelectorAll('.navtree-ws-row')].find((r) =>
      (r.textContent ?? '').includes('Personal'),
    );
    await dblclick(active?.querySelector('.navtree-ws-name'));
    expect(editorIn(box)).toBeTruthy();
  });

  it('opens on a workspace you are NOT in — the whole complaint', async () => {
    const box = mount('sidebar');
    const other = [...box.querySelectorAll('.navtree-ws-row')].find((r) =>
      (r.textContent ?? '').includes('Acmebot'),
    );
    await dblclick(other?.querySelector('.navtree-ws-name'));
    expect(editorIn(box)).toBeTruthy();
  });

  it('says so in the row’s own tooltip, on every row', () => {
    const box = mount('sidebar');
    const titles = [...box.querySelectorAll('.navtree-ws-name')].map((e) =>
      e.getAttribute('title'),
    );
    expect(titles.length).toBeGreaterThan(1);
    expect(titles.every((t) => t === 'Double-click to rename')).toBe(true);
  });
});
