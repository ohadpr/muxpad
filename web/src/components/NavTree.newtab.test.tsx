import type { Tab, Workspace } from '@muxpad/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHERE A NEW CHAT GOES, AND WHO SAID SO.
 *
 * Two arrangements, one per view, because the two views know different amounts
 * about WHERE:
 *
 *   grouped   ONE BUTTON PER WORKSPACE, as its list's first row. The heading
 *             directly above the button is the answer, so the click creates and
 *             goes and never asks. This is where it started, briefly was not,
 *             and is again.
 *   recent    ONE BUTTON AT THE TOP, and it ASKS. The flat view renders no
 *             workspace nodes, so it has no per-workspace buttons to inherit —
 *             which is how it once ended up with no way to create at all. And
 *             nothing on that screen names a workspace: every row is a
 *             different one's, so creating in whichever workspace some state
 *             happened to hold is a chat you then cannot find.
 *
 * The middle arrangement — one top button in BOTH views, asking in one of them
 * — is the one this file used to pin, and it failed for the grouped view in
 * practice: reported as "weirdly designed", and picking a workspace from its
 * popup did not reliably leave you in the chat you had just made. A button
 * inside the workspace cannot have either problem.
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
  { id: 'w-trayo', slug: 'trayo', name: 'Trayo', tabs: [tab('t1')] },
  { id: 'w-bots', slug: 'bots', name: 'Trayobot', tabs: [tab('b1')] },
];
const WORKSPACES = CORPUS.map(
  (g) => ({ id: g.id, slug: g.slug, name: g.name, created_at: NOW, updated_at: NOW }) as Workspace,
);

/** Every `api.createTab` this render made, in order. */
let CREATED: { workspaceId: string; body: Record<string, unknown> }[] = [];
/** Every route the surface navigated to. */
let WENT: { wsSlug: string; tabSlug: string }[] = [];

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  useNavigate: () => (opts: { params: { wsSlug: string; tabSlug: string } }) => {
    WENT.push(opts.params);
  },
}));

vi.mock('../api', () => ({
  api: {
    createTab: async (workspaceId: string, body: Record<string, unknown>) => {
      CREATED.push({ workspaceId, body });
      return { ...tab('new'), slug: 'new-chat' };
    },
    createWorkspace: async () => WORKSPACES[0],
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
const { resetNavView, setNavView } = await import('../lib/nav-view');

type Variant = 'sidebar' | 'sheet';

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount(variant: Variant, view: 'recent' | 'spaces'): HTMLElement {
  setNavView(variant === 'sheet' ? 'sheet' : 'sidebar', view);
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
  resetNavView();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  resetNavView();
});

describe('the rail in the GROUPED view — one button per workspace, inside it', () => {
  it('gives every EXPANDED workspace its own, and the rail none of its own', () => {
    const box = mount('sidebar', 'spaces');
    expect(box.querySelectorAll('.navtree-ws-row').length).toBe(3);
    // No top button at all here: the workspaces carry it. A second one above
    // the tree would be a fourth answer to a question already answered three
    // times on the same screen.
    expect(box.querySelectorAll('.navtree-new-tab').length).toBe(0);
    // One per EXPANDED workspace — default expansion is active-workspace-only,
    // and a collapsed workspace renders no list to put a row in.
    const lists = box.querySelectorAll('.navtree-tab-list');
    expect(box.querySelectorAll('.navtree-add-ws').length).toBe(lists.length);
    expect(lists.length).toBeGreaterThan(0);
  });

  it('is the FIRST row of its workspace, not the last', () => {
    const box = mount('sidebar', 'spaces');
    // The original sat below however many chats the workspace had, so in a
    // twenty-chat workspace "make another one" was a scroll away.
    const list = box.querySelector('.navtree-tab-list');
    expect(list?.firstElementChild?.classList.contains('navtree-add-ws')).toBe(true);
  });

  it('creates in ITS OWN workspace and goes there, asking nothing', async () => {
    const box = mount('sidebar', 'spaces');
    await click(box.querySelector('.navtree-add-ws'));
    expect(CREATED).toEqual([{ workspaceId: 'w-personal', body: { ...HOUSE_CHAT_CREATE } }]);
    // THE BUG THAT SENT IT BACK HERE: "picking a workspace leaves me on my
    // current tab". One click, and the navigation is to the new chat.
    expect(WENT).toEqual([{ wsSlug: 'personal', tabSlug: 'new-chat' }]);
    // No picker was ever shown.
    expect(box.querySelectorAll('.navtree-wspick-name').length).toBe(0);
  });
});

describe('the rail in the RECENT view — one button at the top', () => {
  it('has one, because this view has no workspace rows to hang them on', () => {
    const box = mount('sidebar', 'recent');
    expect(box.querySelectorAll('.navtree-new-tab').length).toBe(1);
    expect(box.querySelectorAll('.navtree-add-ws').length).toBe(0);
    const scroll = box.querySelector('.navtree-scroll');
    expect(scroll?.firstElementChild?.classList.contains('navtree-new-tab')).toBe(true);
  });
});

describe('the rail’s new-tab button in RECENT view — it asks where', () => {
  it('opens a workspace picker instead of creating', async () => {
    const box = mount('sidebar', 'recent');
    const btn = box.querySelector('.navtree-new-tab');
    await click(btn);
    expect(CREATED).toEqual([]);
    // Every visible workspace is offered, and the button says it is open.
    const names = [...box.querySelectorAll('.navtree-wspick-name')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(names).toEqual(['Personal', 'Trayo', 'Trayobot']);
    expect(btn?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the active workspace as the DEFAULT rather than assuming it', async () => {
    const box = mount('sidebar', 'recent');
    await click(box.querySelector('.navtree-new-tab'));
    const marked = [...box.querySelectorAll('.navtree-wspick-row[data-active="true"]')].map((r) =>
      (r.querySelector('.navtree-name-text')?.textContent ?? '').trim(),
    );
    expect(marked).toEqual(['Personal']);
    // Named, not merely tinted — a band alone is the same mark the switch
    // surface uses for "you are here".
    expect(
      box.querySelector('.navtree-wspick-row[data-active="true"] .navtree-wspick-note')
        ?.textContent,
    ).toBe('default');
    // And it is still a CHOICE: nothing was created by opening the list.
    expect(CREATED).toEqual([]);
  });

  it('creates in the workspace you CHOSE, not the one you were in', async () => {
    const box = mount('sidebar', 'recent');
    await click(box.querySelector('.navtree-new-tab'));
    await click(pickerRow(box, 'Trayobot'));
    expect(CREATED).toEqual([{ workspaceId: 'w-bots', body: { ...HOUSE_CHAT_CREATE } }]);
    expect(WENT).toEqual([{ wsSlug: 'bots', tabSlug: 'new-chat' }]);
  });

  it('Escape dismisses it, and nothing is created', async () => {
    const box = mount('sidebar', 'recent');
    await click(box.querySelector('.navtree-new-tab'));
    await act(async () => {
      box
        .querySelector('.navtree-wspick-name')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(box.querySelectorAll('.navtree-wspick-name').length).toBe(0);
    expect(CREATED).toEqual([]);
    // The chats are back.
    expect(box.querySelectorAll('.navtree-tab-row').length).toBeGreaterThan(0);
  });
});

describe('the sheet — the bar’s "+" asks the same question', () => {
  it('recent: opens the picker rather than guessing a workspace', async () => {
    const box = mount('sheet', 'recent');
    // No "+ New tab" row was put back into a scroller that holds only chats.
    expect(box.querySelectorAll('.navtree-new-tab').length).toBe(0);
    const plus = box.querySelector('[aria-label="New chat"]');
    await click(plus);
    expect(CREATED).toEqual([]);
    expect(pickerRow(box, 'Trayobot')).toBeTruthy();
    await click(pickerRow(box, 'Trayobot'));
    expect(CREATED).toEqual([{ workspaceId: 'w-bots', body: { ...HOUSE_CHAT_CREATE } }]);
  });

  it('grouped: still creates straight into the workspace the bar names', async () => {
    const box = mount('sheet', 'spaces');
    await click(box.querySelector('[aria-label="New chat"]'));
    expect(CREATED).toEqual([{ workspaceId: 'w-personal', body: { ...HOUSE_CHAT_CREATE } }]);
  });
});
