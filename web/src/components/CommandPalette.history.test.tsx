import type { Tab } from '@muxpad/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveSearchHit } from '../api';
import type { WorkspaceTabs } from '../lib/nav-search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ⌘K OVER FINISHED HISTORY. The live corpus (`/api/tabs/all`) carries only live
 * chats; a finished one is reached through `/api/tabs/lookup` — by its name,
 * and by the pane behind an archive hit (lib/tab-lookup).
 */
const tab = (id: string, layout: string, over: Partial<Tab> = {}): Tab =>
  ({ id, slug: id, name: id, layout, created_at: 1, updated_at: 1, ...over }) as Tab;

let LIVE: WorkspaceTabs[] = [];
const BASE_LIVE: WorkspaceTabs[] = [
  { id: 'w1', slug: 'personal', name: 'Personal', tabs: [tab('livechat', 'p-live')] },
];
/** When set, `/api/tabs/all` never answers — the per-workspace fallback is all there is. */
let allHangs = false;
let VISIBLE: Array<{ id: string; slug: string; name: string }> = [];
let CACHED: Record<string, Tab[]> = {};
const OLD: WorkspaceTabs = {
  id: 'w2',
  slug: 'archive-ws',
  name: 'Elsewhere',
  tabs: [tab('quarterly-taxes', 'p-old', { done: true, done_reason: 'archived' })],
};

type By = { q: string } | { paneIds: readonly string[] };
const lookups: By[] = [];
const searches: Array<{ q: string; resolve: (v: { hits: ArchiveSearchHit[] }) => void }> = [];
vi.mock('../api', () => ({
  api: {
    listAllTabs: () =>
      allHangs ? new Promise<never>(() => {}) : Promise.resolve({ workspaces: LIVE }),
    searchMessages: (q: string) =>
      new Promise<{ hits: ArchiveSearchHit[] }>((resolve) => searches.push({ q, resolve })),
    lookupTabs: async (by: By) => {
      lookups.push(by);
      if ('q' in by) return { workspaces: 'quarterly'.startsWith(by.q.toLowerCase()) ? [OLD] : [] };
      return { workspaces: by.paneIds.includes('p-old') ? [OLD] : [] };
    },
  },
  req: (path: string) =>
    path === '/api/apps'
      ? Promise.resolve({ apps: [] })
      : path === '/api/publish'
        ? Promise.resolve({ publishes: [], base: null })
        : Promise.reject(new Error(path)),
}));
vi.mock('../events', () => ({ subscribe: () => () => {}, subscribeResync: () => () => {} }));
const navigate = vi.fn(async () => {});
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: VISIBLE }),
  visibleWorkspaces: () => VISIBLE,
}));
vi.mock('../tabs', () => ({ cachedTabsFor: (id: string) => CACHED[id] ?? [] }));
vi.mock('../lib/search-jump', () => ({ requestSearchJump: () => {} }));

const { CommandPalette } = await import('./CommandPalette');
const { openCommandPalette } = await import('../lib/command-palette');
const { resetAllTabsCache } = await import('../lib/all-tabs');
const { resetOutputsCache } = await import('../lib/outputs-corpus');
const { resetTabLookup } = await import('../lib/tab-lookup');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetAllTabsCache();
  resetOutputsCache();
  resetTabLookup();
  lookups.length = 0;
  LIVE = BASE_LIVE;
  allHangs = false;
  VISIBLE = [];
  CACHED = {};
  searches.length = 0;
  navigate.mockClear();
  window.history.replaceState({}, '', '/');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CommandPalette />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const input = () => host.querySelector('.cmdk-input') as HTMLInputElement;
const type = (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('a finished chat is still found', () => {
  it('by NAME — after the instant tier, from a bounded lookup', async () => {
    await act(async () => openCommandPalette());
    type('quart');
    // The instant tier answers alone on the keystroke: nothing asked yet.
    expect(options()).toEqual([]);
    expect(lookups).toEqual([]);
    await wait(260); // past the lookup debounce
    expect(lookups).toEqual([{ q: 'quart' }]);
    expect(options()).toEqual([expect.stringContaining('quarterly-taxes')]);
  });

  it('by what was SAID in it — an archive hit whose pane the live corpus lacks', async () => {
    await act(async () => openCommandPalette());
    type('deductions');
    await wait(200);
    const s = searches.find((x) => x.q === 'deductions');
    await act(async () => {
      s?.resolve({
        hits: [
          {
            sid: 'sess-old',
            ts: 1,
            role: 'assistant',
            snippet: 'the «deductions» list',
            session: { sid: 'sess-old', pane_id: 'p-old', cwd: null, assistant: null },
          },
        ],
      });
    });
    await wait(20);
    expect(lookups).toContainEqual({ paneIds: ['p-old'] });
    expect(options()).toEqual([expect.stringContaining('quarterly-taxes')]);
  });
});

describe('history ranks strictly under the live tier', () => {
  it('a finished chat with the better name match lands BELOW the live one', async () => {
    LIVE = [
      {
        id: 'w1',
        slug: 'personal',
        name: 'Personal',
        tabs: [tab('my-quart-plan', 'p-live')],
      },
    ];
    await act(async () => openCommandPalette());
    type('quart');
    expect(options()).toEqual([expect.stringContaining('my-quart-plan')]);
    await wait(260);
    // `quarterly-taxes` is a PREFIX match and `my-quart-plan` only a substring
    // one: ranked together the finished chat would jump above the row the
    // keystroke already drew.
    expect(options()).toEqual([
      expect.stringContaining('my-quart-plan'),
      expect.stringContaining('quarterly-taxes'),
    ]);
  });
});

describe('the fallback before the corpus lands is the live tier too', () => {
  it('a finished row in the sidebar cache is not an instant match', async () => {
    allHangs = true;
    VISIBLE = [{ id: 'w1', slug: 'personal', name: 'Personal' }];
    CACHED = {
      w1: [
        tab('open-thing', 'p1', { corpus_live: true }),
        tab('closed-thing', 'p2', { done: true, corpus_live: false }),
        // An older server sends no flag: absent reads as live.
        tab('legacy-thing', 'p3'),
      ],
    };
    // Re-mounted so the hook reads the fallback with these caches in place.
    act(() => root.render(<CommandPalette key="again" />));
    await act(async () => openCommandPalette());
    type('thing');
    expect(options()).toEqual([
      expect.stringContaining('open-thing'),
      expect.stringContaining('legacy-thing'),
    ]);
  });
});
