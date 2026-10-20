import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveSearchHit } from '../api';
import type { WorkspaceTabs } from '../lib/nav-search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: string, layout: string, over: Partial<Tab> = {}): Tab =>
  ({ id, slug: id, name: id, layout, created_at: 1, updated_at: 1, ...over }) as Tab;

let SERVER: WorkspaceTabs[] = [];
const listAllTabs = vi.fn(async () => ({ workspaces: SERVER }));
/** Pending `/api/search` answers, resolved by hand so a test controls timing. */
const searches: Array<{ q: string; resolve: (v: { hits: ArchiveSearchHit[] }) => void }> = [];
vi.mock('../api', () => ({
  api: {
    listAllTabs: () => listAllTabs(),
    searchMessages: (q: string) =>
      new Promise<{ hits: ArchiveSearchHit[] }>((resolve) => searches.push({ q, resolve })),
  },
}));

const handlers = new Set<(e: MuxpadEvent) => void>();
vi.mock('../events', () => ({
  subscribe: (h: (e: MuxpadEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  subscribeResync: () => () => {},
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => Promise.resolve() }));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [] }),
  visibleWorkspaces: () => [],
}));
vi.mock('../tabs', () => ({ cachedTabsFor: () => [] }));
const requestSearchJump = vi.fn();
vi.mock('../lib/search-jump', () => ({
  requestSearchJump: (j: unknown) => requestSearchJump(j),
}));

const { CommandPalette } = await import('./CommandPalette');
const { openCommandPalette } = await import('../lib/command-palette');
const { resetAllTabsCache } = await import('../lib/all-tabs');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetAllTabsCache();
  searches.length = 0;
  requestSearchJump.mockClear();
  SERVER = [
    {
      id: 'w1',
      slug: 'personal',
      name: 'Personal',
      tabs: [tab('zzz', 'p'), tab('deleteme', 'q')],
    },
  ];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CommandPalette />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/**
 * The search ENGINE's contract, as the palette — its one surface — exposes it.
 * These were NavSearch's tests, from when the rail had an inline box over the
 * same engine; the box became a button that opens this.
 */
const input = () => host.querySelector('.cmdk-input') as HTMLInputElement;
/** Open the palette the way the rail's button and the sheet's magnifier do. */
const open = () =>
  act(async () => {
    openCommandPalette();
  });
const type = (value: string) => {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const press = (key: string) =>
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
const options = () => [...host.querySelectorAll('[role="option"]')];
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('a message result never outlives its query', () => {
  it('Enter on a new query does not open the previous query’s message', async () => {
    await open();
    type('alpha');
    await wait(200); // past the debounce
    expect(searches.map((s) => s.q)).toEqual(['alpha']);
    await act(async () => {
      searches[0]?.resolve({
        hits: [
          {
            sid: 'session-alpha',
            ts: 42,
            role: 'assistant',
            snippet: 'alpha',
            session: { sid: 'session-alpha', pane_id: 'p', cwd: null, assistant: null },
          },
        ],
      });
    });
    expect(options()).toHaveLength(1);

    // Replace the query; the new request has not even been sent yet.
    type('bravo');
    press('Enter');
    // Opening session-alpha while handing it the query "bravo" is the bug.
    expect(requestSearchJump).not.toHaveBeenCalled();
    expect(options()).toHaveLength(0);
  });
});

describe('the corpus it searches is the shared, live one', () => {
  it('a chat deleted while the palette is open stops being a result', async () => {
    await open();
    await wait(0);
    type('deleteme');
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('deleteme')]);

    act(() => {
      for (const h of handlers)
        h({ type: 'tab.removed', workspace_id: 'w1', tab_id: 'deleteme' } as MuxpadEvent);
    });
    expect(options()).toHaveLength(0);
  });
});

it('does not overwrite a healed corpus with the older open-request result', async () => {
  let finish!: (v: { workspaces: WorkspaceTabs[] }) => void;
  const old = SERVER;
  listAllTabs.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await open();
  await act(async () => {
    for (const h of handlers)
      h({ type: 'tab.removed', tab_id: 'deleteme', workspace_id: 'w1' } as MuxpadEvent);
    SERVER = [{ ...old[0]!, tabs: [tab('zzz', 'p')] }];
    finish({ workspaces: old });
  });
  type('deleteme');
  expect(host.querySelector('[role="option"]')).toBeNull();
});

describe('opening from a button', () => {
  it('opens on the window event, focused at once — iOS raises the keyboard only then', async () => {
    expect(host.querySelector('.cmdk-dialog')).toBeNull();
    // Synchronously: no act-flush, no frame. The focus has to happen inside
    // the tap's own call stack, or a phone shows a field with no keyboard.
    await act(async () => {
      openCommandPalette();
      // Asserted INSIDE the act, before it flushes anything of its own (the
      // async act only absorbs the corpus load that opening kicks off).
      expect(host.querySelector('.cmdk-dialog')).not.toBeNull();
      expect(document.activeElement).toBe(input());
    });
  });

  it('opens rather than toggles: a second press leaves it open', async () => {
    await open();
    await open();
    expect(host.querySelector('.cmdk-dialog')).not.toBeNull();
  });
});
