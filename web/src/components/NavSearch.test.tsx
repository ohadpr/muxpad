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

const { NavSearch } = await import('./NavSearch');
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
  act(() => root.render(<NavSearch variant="sidebar">tree</NavSearch>));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const input = () => host.querySelector('input') as HTMLInputElement;
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

describe('NavSearch — a message result never outlives its query', () => {
  it('Enter on a new query does not open the previous query’s message', async () => {
    await act(async () => {
      input().focus();
    });
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
