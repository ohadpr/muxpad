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
  // The hosted-outputs tier reaches for `req` (lib/hosted). Answered rather
  // than stubbed to throw: the tier is meant to cost the search NOTHING when
  // it has nothing, and a rejection here would be the only way to tell a real
  // regression from a missing mock. The outputs tier has its own tests.
  req: (path: string) =>
    path === '/api/apps'
      ? Promise.resolve({ apps: [] })
      : path === '/api/publish'
        ? Promise.resolve({ publishes: [], base: null })
        : Promise.reject(new Error(path)),
}));

const handlers = new Set<(e: MuxpadEvent) => void>();
vi.mock('../events', () => ({
  subscribe: (h: (e: MuxpadEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  subscribeResync: () => () => {},
}));
const navigate = vi.fn(async () => {});
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
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
const { resetOutputsCache } = await import('../lib/outputs-corpus');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetAllTabsCache();
  resetOutputsCache();
  searches.length = 0;
  requestSearchJump.mockClear();
  navigate.mockClear();
  // The palette reads the path to leave out the chat you are standing on.
  window.history.replaceState({}, '', '/');
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

/**
 * THE EMPTY QUERY — the recents list that replaced the rail's "Recently
 * active" band. The band's duplication was the problem it was removed for, so
 * what matters here is that this surface carries the workspace a row lives in,
 * is reachable by keyboard on the first press, and gives way the moment you
 * type.
 */
describe('recents, before anything is typed', () => {
  const recentTabs = (): Tab[] => [
    tab('investing', 'p1', { last_user_at: 3_000 }),
    tab('muxpad', 'p2', { last_user_at: 2_000 }),
    tab('home', 'p3', { last_user_at: 1_000 }),
  ];

  beforeEach(() => {
    SERVER = [{ id: 'w1', slug: 'personal', name: 'Personal', tabs: recentTabs() }];
    resetAllTabsCache();
  });

  const heading = () =>
    [...host.querySelectorAll('.cmdk-divider')].map((d) => d.textContent?.trim());

  it('lists the chats you touched most recently, newest first', async () => {
    await open();
    await wait(0);
    expect(options().map((o) => o.querySelector('.navsearch-row-title')?.textContent)).toEqual([
      'investing',
      'muxpad',
      'home',
    ]);
    expect(heading()).toEqual(['Recent']);
  });

  it('says which workspace each row lives in — the thing the old band could not', async () => {
    await open();
    await wait(0);
    expect(options()[0]?.querySelector('.navsearch-row-ws')?.textContent).toBe('Personal');
  });

  it('leaves out the chat you are looking at', async () => {
    window.history.replaceState({}, '', '/w/personal/t/investing');
    await open();
    await wait(0);
    expect(options().map((o) => o.querySelector('.navsearch-row-title')?.textContent)).toEqual([
      'muxpad',
      'home',
    ]);
  });

  it('Enter navigates on the FIRST press, with no arrow key first', async () => {
    // The whole point of a keyboard switcher. The cursor starts at 0 and the
    // combobox has to call itself expanded for a reader to follow it there.
    await open();
    await wait(0);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    press('Enter');
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { wsSlug: 'personal', tabSlug: 'investing' } }),
    );
  });

  it('gives way to matches as you type, and comes back when you clear', async () => {
    await open();
    await wait(0);
    expect(options()).toHaveLength(3);
    type('home');
    expect(options().map((o) => o.querySelector('.navsearch-row-title')?.textContent)).toEqual([
      'home',
    ]);
    expect(heading()).toEqual([]);
    type('');
    expect(options()).toHaveLength(3);
    expect(heading()).toEqual(['Recent']);
  });

  it('does not print "type to search" over a list you can already arrow through', async () => {
    await open();
    await wait(0);
    expect(host.querySelector('.cmdk-empty')).toBeNull();
  });

  it('still explains itself when there is genuinely nothing to list', async () => {
    SERVER = [{ id: 'w1', slug: 'personal', name: 'Personal', tabs: [] }];
    resetAllTabsCache();
    await open();
    await wait(0);
    expect(host.querySelector('.cmdk-empty')?.textContent).toContain('Type to find a chat');
  });
});

/**
 * A TAP ON A RESULT MUST NOT BE SPENT DISMISSING THE KEYBOARD.
 *
 * Reported: "search results don't even respond, can't click them" — on the
 * phone, where the keyboard is up because you just typed the query.
 *
 * The mechanism, confirmed in the browser before this test was written: the
 * input holds focus, a result row is `tabIndex=-1`, and nothing prevented the
 * press's default — so the press moves focus off the input. On iOS that focus
 * change IS the keyboard dismissing, and the tap is spent doing it rather
 * than picking the row. Worse, the dismissal relayouts the list (the results
 * reserve `--chat-keyboard-inset` at their foot), so the row you aimed at has
 * moved by the time you try again.
 *
 * The fix is the one every combobox uses: the listbox refuses the focus
 * change, so focus stays in the input and the click lands. It is invisible on
 * a desktop — which is why it was never noticed — and it is the whole
 * difference on a phone.
 */
describe('pressing a result keeps the keyboard up', () => {
  const listbox = () => host.querySelector('.cmdk-results') as HTMLElement;

  it('refuses the focus change that a press would otherwise cause', async () => {
    await open();
    type('zzz');
    expect(options().length).toBeGreaterThan(0);
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    options()[0]?.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('refuses it anywhere in the list, not only on a row', async () => {
    // A thumb lands in the gaps between rows too, and the same focus change
    // happens there.
    await open();
    type('zzz');
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    listbox().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('still picks the row — refusing focus must not refuse the click', async () => {
    await open();
    type('zzz');
    act(() => {
      options()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalled();
  });
});
