import type { Tab, Workspace } from '@muxpad/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SEARCH IS THE PALETTE, AND THE SHEET'S WORKSPACE ROW HAS TWO CONTROLS.
 *
 * 1. The rail's inline search field is gone. In its place a "Search chats"
 *    button opens the ⌘K palette (lib/command-palette's window event), and the
 *    sheet's magnifier does the same instead of swapping in a field — on a phone
 *    it is the only way to reach the palette at all.
 * 2. On the sheet, a workspace row carries "+" and "⋯" and nothing else.
 *    Settings, rename and close live in the "⋯" menu, so the destructive one is
 *    never a glyph beside the button you tap all day. The 44px targets are
 *    pinned in NavTree.spacing.test; the 15px glyphs here.
 *
 * Harness copied from NavTree.newtab.test: the ambient four mocks plus `api`.
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
/** Every `api.deleteWorkspace` this render made. */
let DELETED: string[] = [];
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
    deleteWorkspace: async (id: string) => {
      DELETED.push(id);
    },
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
const { PALETTE_OPEN_EVENT } = await import('../lib/command-palette');

type Variant = 'sidebar' | 'sheet';

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount(variant: Variant, onNavigate?: () => void): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <NavTree
        activeWorkspaceSlug="personal"
        activeTabSlug="p1"
        variant={variant}
        {...(onNavigate ? { onNavigate } : {})}
      />,
    );
  });
  return host;
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

let PALETTE_OPENS = 0;
const onPaletteOpen = () => {
  PALETTE_OPENS++;
};

beforeEach(() => {
  CREATED = [];
  DELETED = [];
  WENT = [];
  PALETTE_OPENS = 0;
  window.addEventListener(PALETTE_OPEN_EVENT, onPaletteOpen);
});

afterEach(() => {
  window.removeEventListener(PALETTE_OPEN_EVENT, onPaletteOpen);
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const controls = (row: Element) => [
  ...row.querySelectorAll(':scope > .navtree-tab-controls > button'),
];
const rowFor = (box: HTMLElement, name: string) =>
  [...box.querySelectorAll('.navtree-ws-row')].find((r) =>
    (r.textContent ?? '').includes(name),
  ) as HTMLElement;
const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];

describe('the rail’s search is a button that opens the palette', () => {
  it('renders “Search chats” with the chord, and no field', () => {
    const box = mount('sidebar');
    const btn = box.querySelector('button.navtree-search');
    expect(btn?.textContent).toContain('Search chats');
    expect(btn?.querySelector('kbd')?.textContent).toMatch(/K$/);
    expect(box.querySelector('input')).toBeNull();
    expect(box.querySelector('.navsearch, [role="combobox"]')).toBeNull();
  });

  it('opens the palette on click', async () => {
    const box = mount('sidebar');
    await click(box.querySelector('button.navtree-search'));
    expect(PALETTE_OPENS).toBe(1);
  });

  it('keeps the tree in the scroller — nothing swaps it out any more', () => {
    const box = mount('sidebar');
    expect(box.querySelectorAll('.navtree-scroll .navtree-ws-row').length).toBe(3);
  });
});

describe('the sheet’s magnifier opens the palette instead of a field', () => {
  it('opens the palette and dismisses the sheet, without ever drawing a field', async () => {
    const onNavigate = vi.fn();
    const box = mount('sheet', onNavigate);
    expect(box.querySelector('input')).toBeNull();
    await click(box.querySelector('.navtree-bar [aria-label="Search chats"]'));
    expect(PALETTE_OPENS).toBe(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // The old magnifier REPLACED the bar with an inline field.
    expect(box.querySelector('input')).toBeNull();
    expect(box.querySelector('.navtree-bar')).not.toBeNull();
  });
});

describe('the sheet’s workspace row: “+” and “⋯”, nothing else', () => {
  it('has exactly those two controls, in that order, on every workspace', () => {
    const box = mount('sheet');
    const rows = [...box.querySelectorAll('.navtree-ws-row')];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      const labels = controls(row).map((b) => b.getAttribute('aria-label') ?? '');
      expect(labels).toEqual([
        expect.stringMatching(/^New chat in /),
        expect.stringMatching(/^More for /),
      ]);
    }
  });

  it('puts nothing destructive in the row, so nothing destructive is beside “+”', () => {
    const box = mount('sheet');
    const row = rowFor(box, 'Personal');
    const add = row.querySelector('.navtree-ws-add');
    // Neither neighbour of "+" closes anything — and there is no close in the
    // row at all.
    for (const sib of [add?.previousElementSibling, add?.nextElementSibling]) {
      expect(sib?.getAttribute('aria-label') ?? '').not.toMatch(/close/i);
    }
    expect(row.querySelector('[aria-label^="Close workspace"]')).toBeNull();
    expect(row.querySelector('.navtree-ws-settings')).toBeNull();
  });

  it('draws 15px glyphs inside the 44px targets', () => {
    const box = mount('sheet');
    for (const b of controls(rowFor(box, 'Personal'))) {
      const svg = b.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('15');
      expect(svg?.getAttribute('height')).toBe('15');
    }
  });

  it('“⋯” opens settings, rename, and close — close last, and marked destructive', async () => {
    const box = mount('sheet');
    const more = rowFor(box, 'Personal').querySelector('.navtree-ws-more');
    expect(more?.getAttribute('aria-expanded')).toBe('false');
    await click(more);
    expect(more?.getAttribute('aria-expanded')).toBe('true');
    const items = menuItems();
    expect(items.map((i) => i.textContent)).toEqual([
      'Workspace settings',
      'Rename',
      'Close workspace',
    ]);
    expect(items[2]?.classList.contains('-danger')).toBe(true);
    expect(items.slice(0, 2).some((i) => i.classList.contains('-danger'))).toBe(false);
    // The thumb-sized variant of the menu (44px rows, pinned in the CSS test).
    expect(document.querySelector('.navtree-menu.-touch')).not.toBeNull();
  });

  it('closes the workspace from the menu', async () => {
    const box = mount('sheet');
    await click(rowFor(box, 'Acme').querySelector('.navtree-ws-more'));
    await click(menuItems().find((i) => i.textContent === 'Close workspace'));
    expect(DELETED).toEqual(['w-acme']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('renames from the menu', async () => {
    const box = mount('sheet');
    await click(rowFor(box, 'Acme').querySelector('.navtree-ws-more'));
    await click(menuItems().find((i) => i.textContent === 'Rename'));
    // The row's name is now an input, so find it by position (Acme is second).
    const row = box.querySelectorAll('.navtree-ws-row')[1];
    expect(row?.querySelector('input')).not.toBeNull();
  });
});

describe('the desktop row is untouched', () => {
  it('keeps settings, “+” and × on the rail', () => {
    const box = mount('sidebar');
    const labels = controls(rowFor(box, 'Personal')).map((b) => b.className);
    expect(labels).toEqual([
      'navtree-close navtree-ws-settings',
      'navtree-close navtree-ws-add',
      'navtree-close',
    ]);
    expect(box.querySelector('.navtree-ws-more')).toBeNull();
  });
});
