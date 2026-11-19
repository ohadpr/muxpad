import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceTabs } from '../lib/nav-search';

/**
 * ⌘K FINDS THE THING YOU MADE — end to end, with the query that prompted it.
 *
 * "Link to tom Romy game portal" was asked three times in five days, in two
 * chats. The answer is an APP called `rail-rush-internal` whose name and slug
 * contain neither word; they are in its working directory. This file drives
 * the real palette over a registry shaped like the real one.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: string): Tab =>
  ({ id, slug: id, name: id, layout: 'p', created_at: 1, updated_at: 1 }) as Tab;

const SERVER: WorkspaceTabs[] = [
  { id: 'w1', slug: 'personal', name: 'Personal', tabs: [tab('zzz'), tab('Home')] },
];

const APPS = {
  apps: [
    {
      id: 'a1',
      slug: 'rail-rush-internal',
      name: 'rail-rush-internal',
      cwd: '/Users/me/MyDev/2026/tom-romy-surfers/dist-internal',
      command: './serve',
      url: 'http://100.118.83.18:8876',
      autostart: true,
      enabled: true,
      pane_id: null,
      created_at: 1,
      updated_at: 1,
      state: 'running',
      pty: true,
      health: null,
      origin_tab: 'Home',
    },
  ],
};
const PUBLISHES = {
  publishes: [
    {
      slug: 'roof-office-7k3mqp2x',
      name: 'roof-office',
      files: 1,
      bytes: 10,
      created: 1,
      expires: 1,
      expired: true,
      url: 'https://pub.example/roof-office-7k3mqp2x/',
      versions: [],
      // No recorded origin — published from an ordinary shell, which is the
      // common case and not a defect.
      origin_tab: null,
    },
  ],
  base: null,
};

vi.mock('../api', () => ({
  api: {
    listAllTabs: async () => ({ workspaces: SERVER }),
    searchMessages: () => new Promise(() => {}),
  },
  req: (path: string) =>
    path === '/api/apps'
      ? Promise.resolve(APPS)
      : path === '/api/publish'
        ? Promise.resolve(PUBLISHES)
        : Promise.reject(new Error(path)),
}));
vi.mock('../events', () => ({
  subscribe: (_h: (e: MuxpadEvent) => void) => () => {},
  subscribeResync: () => () => {},
}));
const navigate = vi.fn(async () => {});
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [] }),
  visibleWorkspaces: () => [],
}));
vi.mock('../tabs', () => ({ cachedTabsFor: () => [] }));
vi.mock('../lib/search-jump', () => ({ requestSearchJump: () => {} }));

const { CommandPalette } = await import('./CommandPalette');
const { openCommandPalette } = await import('../lib/command-palette');
const { resetAllTabsCache } = await import('../lib/all-tabs');
const { resetOutputsCache } = await import('../lib/outputs-corpus');

let host: HTMLDivElement;
let root: Root;
const written: string[] = [];

beforeEach(() => {
  resetAllTabsCache();
  resetOutputsCache();
  navigate.mockClear();
  written.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        written.push(t);
      },
    },
  });
  vi.stubGlobal('open', vi.fn());
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CommandPalette />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const input = () => host.querySelector('.cmdk-input') as HTMLInputElement;
const open = async () => {
  await act(async () => {
    openCommandPalette();
  });
  // Let the lazy corpus land before the first keystroke.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
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
const outputs = () => [...host.querySelectorAll('.navsearch-row-output')];

it('finds the games portal by the words in its folder, and Enter opens it', async () => {
  await open();
  type('tom romy');
  expect(outputs()).toHaveLength(1);
  expect(outputs()[0]?.querySelector('.navsearch-row-title')?.textContent).toBe(
    'rail-rush-internal',
  );
  // It appeared for a reason that is not on screen, so the row says so.
  expect(outputs()[0]?.textContent).toContain('matched its folder');

  press('Enter');
  // An APP opens inside muxpad — the route that also carries its logs and its
  // start/stop controls, so a stopped one lands somewhere that can fix it.
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: { slug: 'rail-rush-internal' } }),
  );
});

it('says which are public and which are tailnet-only', async () => {
  await open();
  type('roof');
  expect(outputs()[0]?.textContent).toContain('Artifact · public');
  type('tom romy');
  expect(outputs()[0]?.textContent).toContain('App · tailnet only');
});

it('keeps an expired artifact listed, labelled', async () => {
  // The bytes are still there and `--extend` revives the link.
  await open();
  type('roof');
  expect(outputs()).toHaveLength(1);
  expect(outputs()[0]?.textContent).toContain('link expired');
});

it('opens an artifact in a NEW TAB, not over the cockpit', async () => {
  await open();
  type('roof');
  press('Enter');
  expect(navigate).not.toHaveBeenCalled();
  expect(window.open).toHaveBeenCalledWith(
    'https://pub.example/roof-office-7k3mqp2x/',
    '_blank',
    'noopener,noreferrer',
  );
});

it('Copy takes the link without opening anything', async () => {
  // Half the time the question is "give me the link to send", which is what
  // got asked three times.
  await open();
  type('tom romy');
  const copy = outputs()[0]?.querySelector('.navsearch-row-copy') as HTMLButtonElement;
  expect(copy).toBeTruthy();
  await act(async () => {
    copy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(written).toEqual(['http://100.118.83.18:8876']);
  // The row itself opens; the button must not, or the palette would close on
  // the way to the clipboard.
  expect(navigate).not.toHaveBeenCalled();
  expect(host.querySelector('.cmdk-dialog')).not.toBeNull();
});

it('sits UNDER the chats, so it cannot push one off the top', async () => {
  await open();
  type('zzz'); // a chat name, and nothing in the registry
  const rows = [...host.querySelectorAll('[role="option"]')];
  expect(rows[0]?.classList.contains('navsearch-row-output')).toBe(false);
});

it('shows nothing before anything is typed — the recents are chats', async () => {
  await open();
  expect(outputs()).toHaveLength(0);
});

it('says which chat made it, by name', async () => {
  // The record is a tab ID; the row shows a word. Resolved against the corpus
  // the palette already holds, so the server is not asked to join a name onto
  // every row of a polled listing.
  await open();
  type('tom romy');
  expect(outputs()[0]?.textContent).toContain('from Home');
});

it('says nothing about an origin it does not have', async () => {
  // Most things have none: anything made from an ordinary shell, and
  // everything from before the record existed. Nothing is backfilled, because
  // an origin guessed from a timestamp is a wrong chat stated confidently.
  await open();
  type('roof');
  expect(outputs()[0]?.textContent).not.toContain('from');
});

it('says nothing when the chat that made it is gone', async () => {
  // An id that resolves to nothing is not a place to go back to, and naming
  // it would offer one.
  const prev = APPS.apps[0]!.origin_tab;
  APPS.apps[0]!.origin_tab = 'deleted-chat';
  try {
    await open();
    type('tom romy');
    expect(outputs()).toHaveLength(1);
    expect(outputs()[0]?.textContent).not.toContain('from');
  } finally {
    APPS.apps[0]!.origin_tab = prev;
  }
});
