import type { MuxpadEvent } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TabView } from './TabView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mock = vi.hoisted(() => ({
  markTabSeen: vi.fn(async () => {}),
  markPaneSeen: vi.fn(async () => {}),
  getTab: vi.fn(),
  events: new Set<(e: MuxpadEvent) => void>(),
  resync: new Set<() => void>(),
  tab: {
    id: 't',
    slug: 'chat',
    name: 'Chat',
    layout: 'p',
    panes: [{ id: 'p', tab_id: 't', kind: 'shell', title: 'vim', foreground_cmd: 'vim' }],
    view_mode: 'tabbed',
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ wsSlug: 'work' }),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { search: {}, pathname: '/w/work/t/chat' } }),
}));
vi.mock('../api', () => ({
  api: {
    getTab: mock.getTab,
    markTabSeen: mock.markTabSeen,
    markPaneSeen: mock.markPaneSeen,
  },
}));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [{ id: 'w', slug: 'work', name: 'Work' }] }),
  refreshWorkspaces: async () => {},
}));
vi.mock('../tabs', () => ({
  useTabs: () => ({ tabs: [mock.tab] }),
  freshTabs: async () => [mock.tab],
  refreshTabs: async () => {},
}));
vi.mock('../events', () => ({
  subscribe: (fn: (e: MuxpadEvent) => void) => {
    mock.events.add(fn);
    return () => mock.events.delete(fn);
  },
  subscribeResync: (fn: () => void) => {
    mock.resync.add(fn);
    return () => mock.resync.delete(fn);
  },
}));
vi.mock('../use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('../lib/tab-view-mode', () => ({
  useTabViewMode: () => 'tabbed',
  setTabViewMode: vi.fn(),
}));
vi.mock('../components/ShellPaneBody', () => ({ ShellPaneBody: () => null }));
vi.mock('../components/UrlPane', () => ({ UrlPane: () => null }));

afterEach(() => vi.restoreAllMocks());

it('unmounting a background tab does not bulk-acknowledge unseen replies', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const host = document.createElement('div');
  const root = createRoot(host);
  mock.getTab.mockResolvedValue(mock.tab);
  mock.markTabSeen.mockClear();
  mock.markPaneSeen.mockClear();
  try {
    await act(async () => root.render(<TabView tabSlug="chat" isActive={false} />));
  } finally {
    await act(async () => root.unmount());
  }
  expect(mock.markTabSeen).not.toHaveBeenCalled();
  expect(mock.markPaneSeen).not.toHaveBeenCalled();
});

it('a resync cannot restore decorations cleared by a newer pane.updated', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const host = document.createElement('div');
  const root = createRoot(host);
  mock.getTab.mockResolvedValue(mock.tab);
  try {
    await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
    expect(host.textContent).toContain('vim');
    let finish!: (tab: typeof mock.tab) => void;
    mock.getTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => {
      for (const fn of mock.resync) fn();
    });
    const cleared = { ...mock.tab.panes[0], title: null, foreground_cmd: null };
    await act(async () => {
      for (const fn of mock.events)
        fn({ type: 'pane.updated', tab_id: 't', pane: cleared } as MuxpadEvent);
    });
    expect(host.textContent).not.toContain('vim');
    mock.getTab.mockResolvedValue({ ...mock.tab, panes: [cleared] });
    await act(async () => finish(mock.tab));
    expect(host.textContent).not.toContain('vim');
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(['resync', 'reload'] as const)(
  '%s preserves a pane added while the detail GET travels',
  async (path) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const host = document.createElement('div');
    const root = createRoot(host);
    const original = { ...mock.tab };
    mock.getTab.mockResolvedValue(original);
    try {
      await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
      let finish!: (tab: typeof mock.tab) => void;
      mock.getTab.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      if (path === 'resync') {
        act(() => {
          for (const fn of mock.resync) fn();
        });
      } else {
        // A slug change re-runs the same load effect as loadNonce.
        mock.tab.slug = 'renamed';
        await act(async () => root.render(<TabView tabSlug="renamed" isActive={true} />));
      }
      const added = { ...original.panes[0], id: 'q', title: 'NEW PANE' };
      const current = { ...mock.tab, layout: 'q', panes: [...original.panes, added] };
      await act(async () => {
        for (const fn of mock.events) {
          fn({ type: 'pane.added', tab_id: 't', pane: added } as MuxpadEvent);
          fn({ type: 'tab.updated', tab: current } as unknown as MuxpadEvent);
        }
      });
      expect(host.textContent).toContain('NEW PANE');
      mock.getTab.mockResolvedValue(current);
      await act(async () => finish(original));
      expect(host.textContent).toContain('NEW PANE');
    } finally {
      mock.tab.slug = original.slug;
      await act(async () => root.unmount());
    }
  },
);

it.each(['visible', 'hidden'] as const)(
  'acks only the displayed pane when the document is %s',
  async (visibility) => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility);
    const host = document.createElement('div');
    const root = createRoot(host);
    mock.getTab.mockResolvedValue(mock.tab);
    mock.markTabSeen.mockClear();
    mock.markPaneSeen.mockClear();
    try {
      await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
      await act(async () => vi.advanceTimersByTime(301));
      expect(mock.markTabSeen).not.toHaveBeenCalled();
      if (visibility === 'visible') expect(mock.markPaneSeen).toHaveBeenCalledWith('p');
      else expect(mock.markPaneSeen).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  },
);
