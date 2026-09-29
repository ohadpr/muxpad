import type { Tab, Workspace } from '@muxpad/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHERE A NEW CHAT GOES, AND WHO SAID SO.
 *
 * The button used to live at the BOTTOM of each workspace's tab list, one per
 * workspace, which meant the flat 'recent' view — the navigator's default on
 * both surfaces — had no way to make a chat at all: it renders no workspace
 * nodes, so it rendered no "+ New tab" either.
 *
 * Moving it to ONE button at the top re-opens a question the per-workspace
 * button never had to answer: WHICH workspace. In the grouped view the surface
 * still names one (the workspace you are in). In the flat view nothing on
 * screen does — every row is a different workspace's — so the button ASKS
 * rather than guessing. That is the whole of this file:
 *
 *   grouped   one click, into the workspace you are in, no picker
 *   recent    click → a list of workspaces → the one you CHOSE gets the chat
 *
 * The guess is the bug this replaces: a chat created from a flat list landing
 * in whichever workspace some state happened to hold is a chat you then cannot
 * find, because nothing on screen ever named the destination.
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

describe('the rail’s new-tab button — one, at the top, in both views', () => {
  it('is a SINGLE button, ahead of the list, in the grouped view', () => {
    const box = mount('sidebar', 'spaces');
    const adds = box.querySelectorAll('.navtree-new-tab');
    // One, not one per workspace. Three workspaces are rendered.
    expect(box.querySelectorAll('.navtree-ws-row').length).toBe(3);
    expect(adds.length).toBe(1);
    // …and it is the first thing in the scroller, ahead of the view switch.
    const scroll = box.querySelector('.navtree-scroll');
    expect(scroll?.firstElementChild?.classList.contains('navtree-new-tab')).toBe(true);
  });

  it('is there in the RECENT view too — the view that had no way to create', () => {
    const box = mount('sidebar', 'recent');
    expect(box.querySelectorAll('.navtree-new-tab').length).toBe(1);
    const scroll = box.querySelector('.navtree-scroll');
    expect(scroll?.firstElementChild?.classList.contains('navtree-new-tab')).toBe(true);
  });

  it('grouped: creates in the workspace the surface is about, and asks nothing', async () => {
    const box = mount('sidebar', 'spaces');
    await click(box.querySelector('.navtree-new-tab'));
    expect(CREATED).toEqual([{ workspaceId: 'w-personal', body: { ...HOUSE_CHAT_CREATE } }]);
    expect(WENT).toEqual([{ wsSlug: 'personal', tabSlug: 'new-chat' }]);
    // No picker was ever shown.
    expect(box.querySelectorAll('.navtree-wspick-name').length).toBe(0);
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
