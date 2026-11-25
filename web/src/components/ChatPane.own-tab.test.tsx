import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { resetAllTabsCache } from '../lib/all-tabs';
import { resetTabLookup } from '../lib/tab-lookup';
import { ChatPane } from './ChatPane';

/**
 * A FINISHED CHAT STILL KNOWS WHICH TAB IT IS.
 *
 * The live corpus carries live work only, so the chat you are reading may have
 * no row there — and `myChat?.tabId` was the only place two surfaces asked
 * "which chat is this": the browser cards (scoped by tab) and the `@` picker
 * (which must never offer you yourself). Both fall back to the pane's own
 * `tabId` prop now.
 */
const browserCalls = vi.hoisted(() => [] as Array<{ by: string; tabId: string }>);
vi.mock('./BrowserCards', async (original) => {
  const real = await original<typeof import('./BrowserCards')>();
  return {
    ...real,
    useBrowsers: (opts: Parameters<typeof real.useBrowsers>[0]) => {
      browserCalls.push(opts as { by: string; tabId: string });
      return real.useBrowsers(opts);
    },
  };
});
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => () => {},
}));
vi.mock('./SlackApprovalAlert', () => ({ SlackApprovalAlert: () => null }));

class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
  frame(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const row = (id: string, layout: string, over: object = {}) => ({
  id,
  slug: id,
  name: id,
  layout,
  created_at: 1,
  updated_at: 1,
  ...over,
});
/** The live corpus: THIS chat is finished, so it is not in it. */
const LIVE = {
  workspaces: [{ id: 'w1', slug: 'w1', name: 'Home', tabs: [row('unrelated', 'p-else')] }],
};
/** History: this chat itself, and a finished namesake that IS pickable. */
const OLD = {
  workspaces: [
    {
      id: 'w1',
      slug: 'w1',
      name: 'Home',
      tabs: [
        row('herald', 'pane-here', { done: true, done_reason: 'delivered' }),
        row('heraldry', 'p-other', { done: true, done_reason: 'archived' }),
      ],
    },
  ],
};

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetAllTabsCache();
  resetTabLookup();
  browserCalls.length = 0;
  localStorage.clear();
});

async function setup() {
  Socket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  for (const name of ['ResizeObserver', 'IntersectionObserver'])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.startsWith('/api/tabs/all')
        ? LIVE
        : url.startsWith('/api/tabs/lookup?q=her')
          ? OLD
          : url.startsWith('/api/tabs/lookup')
            ? { workspaces: [] }
            : url.startsWith('/api/search')
              ? { hits: [] }
              : url.includes('/spawn-rounds')
                ? { rounds: {}, children: [] }
                : [];
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<ChatPane paneId="pane-here" tabId="herald" active agentNative />),
  );
  const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/pane-here'))!;
  await act(async () => {
    socket.readyState = Socket.OPEN;
    socket.onopen?.();
    socket.frame({
      t: 'session',
      mode: 'chat',
      hasMessages: false,
      turnRunning: false,
      session: null,
    });
  });
}
async function type(text: string) {
  await act(async () => {
    const d = host.querySelector<HTMLElement>('.chat-input')!;
    d.textContent = text;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(d);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    d.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const rows = () => [...host.querySelectorAll('.chat-mention-row')].map((r) => r.textContent);

it('scopes the browser cards to its own tab, absent from the corpus', async () => {
  await setup();
  expect(browserCalls.at(-1)).toEqual({ by: 'pane-here', tabId: 'herald' });
});

it('never offers itself in the @ picker when history brings it back', async () => {
  await setup();
  await type('@her');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  const offered = rows();
  expect(offered).toEqual([expect.stringContaining('heraldry')]);
});
