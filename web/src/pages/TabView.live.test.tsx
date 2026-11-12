import type { MuxpadEvent } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TabView } from './TabView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mock = vi.hoisted(() => ({
  markTabSeen: vi.fn(async () => {}),
  markPaneSeen: vi.fn(async () => {}),
  getTab: vi.fn(),
  freshTabs: vi.fn(),
  cached: [] as unknown[],
  createPane: vi.fn(),
  events: new Set<(e: MuxpadEvent) => void>(),
  resync: new Set<() => void>(),
  tab: {
    id: 't',
    slug: 'chat',
    name: 'Chat',
    layout: 'p',
    panes: [{ id: 'p', tab_id: 't', kind: 'shell', title: 'vim', foreground_cmd: 'vim' }],
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ wsSlug: 'work' }),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { search: {}, pathname: '/w/work/t/chat' } }),
}));
vi.mock('../api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  api: {
    getTab: mock.getTab,
    markTabSeen: mock.markTabSeen,
    markPaneSeen: mock.markPaneSeen,
    createPane: mock.createPane,
  },
}));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [{ id: 'w', slug: 'work', name: 'Work' }] }),
  refreshWorkspaces: async () => {},
}));
vi.mock('../tabs', () => ({
  useTabs: () => ({ tabs: [mock.tab] }),
  freshTabs: mock.freshTabs,
  cachedTabsFor: () => mock.cached,
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
// The body shows the pane's title, so these tests can read pane STATE off the
// page. They used to read it off the pane strip's label, which is gone: a tab
// holds one thing and no longer paints a strip naming it.
vi.mock('../components/ShellPaneBody', () => ({
  ShellPaneBody: ({ pane }: { pane: { title?: string | null } }) => pane.title ?? null,
}));
vi.mock('../components/UrlPane', () => ({ UrlPane: () => null }));

beforeEach(() => {
  mock.cached = [];
  mock.freshTabs.mockReset();
  mock.freshTabs.mockResolvedValue([mock.tab]);
});
afterEach(() => vi.restoreAllMocks());

// Opening a chat from the rail: the slug is already in the cached list, so the
// detail GET goes out at once instead of waiting behind a refetch of the whole
// workspace list (measured 35–490ms on a 505-tab workspace).
it('a slug the cache already holds skips the list refetch', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  mock.cached = [mock.tab];
  mock.getTab.mockResolvedValue(mock.tab);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
    expect(mock.freshTabs).not.toHaveBeenCalled();
    expect(mock.getTab).toHaveBeenCalledWith('t');
    expect(host.textContent).toContain('vim');
  } finally {
    await act(async () => root.unmount());
  }
});

// A chat this client just created: the create answered with its pane, so the
// view renders without waiting for the detail GET (which still corrects it).
it('a just-created tab renders from the primed detail before the GET answers', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  mock.cached = [mock.tab];
  const { primeTabDetail } = await import('../lib/tab-detail-prime');
  primeTabDetail(mock.tab as never);
  mock.getTab.mockImplementationOnce(() => new Promise(() => {}));
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
    expect(host.textContent).toContain('vim');
    expect(mock.getTab).toHaveBeenCalledWith('t');
  } finally {
    await act(async () => root.unmount());
  }
});

it('a cached slug whose tab is gone (404) gets the not-found recovery', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  mock.cached = [mock.tab];
  const { ApiError } = (await import('../api')) as unknown as {
    ApiError: new (m: string, s: number) => Error;
  };
  mock.getTab.mockRejectedValueOnce(new ApiError('tab not found', 404));
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
    expect(host.textContent).toContain('tab not found');
  } finally {
    await act(async () => root.unmount());
  }
});

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

/**
 * A TAB HOLDS ONE THING, AND THE VIEW OFFERS NO WAY TO ADD A SECOND.
 *
 * The fixture's pane is a plain shell — a terminal, the one kind of tab that
 * still painted a strip with a `+`, a "Close pane" and an "Expand to split".
 * That `+` was the web half of the hole: it created a second pane and wrote
 * the split layout itself.
 */
it('paints no pane strip, no `+` and no split control on a terminal tab', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const host = document.createElement('div');
  const root = createRoot(host);
  mock.getTab.mockResolvedValue(mock.tab);
  try {
    await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
    // The terminal itself is on screen…
    expect(host.textContent).toContain('vim');
    // …and nothing around it adds, splits or names a second thing.
    expect(host.querySelector('.desktop-tab-strip')).toBeNull();
    expect(host.querySelector('.mosaic')).toBeNull();
    const controls = [...host.querySelectorAll('button')].map(
      (b) => `${b.textContent}|${b.title}|${b.getAttribute('aria-label') ?? ''}`,
    );
    expect(controls).toEqual([]);
  } finally {
    await act(async () => root.unmount());
  }
});

it('an EMPTY tab offers a chat, and asks the SERVER to place it', async () => {
  // The server refuses a second thing in an occupied tab on every route, and
  // places a first one only when asked to. So the empty state's create must
  // say `append_to_layout`, or the chat would exist in no layout at all.
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const host = document.createElement('div');
  const root = createRoot(host);
  const empty = { ...mock.tab, layout: '', panes: [] };
  mock.getTab.mockResolvedValue(empty);
  mock.createPane.mockReset();
  mock.createPane.mockResolvedValue({ id: 'n', tab_id: 't', kind: 'shell', title: 'fresh chat' });
  try {
    await act(async () => root.render(<TabView tabSlug="chat" isActive={true} />));
    expect(host.textContent).toContain('Nothing is open here.');
    const start = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Start a chat',
    );
    expect(start).toBeTruthy();
    await act(async () => start?.click());
    expect(mock.createPane).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ append_to_layout: true }),
    );
    // And it is on screen straight away, not after a round trip.
    expect(host.textContent).toContain('fresh chat');
  } finally {
    await act(async () => root.unmount());
  }
});
