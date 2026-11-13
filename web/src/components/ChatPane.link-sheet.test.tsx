import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from './ChatPane';

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
  sent: unknown[] = [];
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  frame(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url === '/api/tabs/all' ? { workspaces: [] } : []),
    })),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<ChatPane paneId="link-pane" tabId="link-tab" active agentNative />),
  );
  const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/link-pane'))!;
  await act(async () => {
    socket.readyState = Socket.OPEN;
    socket.onopen?.();
    socket.frame({
      t: 'session',
      mode: 'chat',
      hasMessages: true,
      turnRunning: false,
      session: { current_sid: 'session', writer: 'runner', view_mode: 'chat', assistant: 'claude' },
    });
  });
  return socket;
}

/**
 * THE WIRING: a link in a message, clicked in a real ChatPane, opens the
 * sheet over the conversation rather than leaving muxpad.
 */
it('a link clicked in a message opens the link sheet, not a new tab', async () => {
  const socket = await setup();
  await act(async () =>
    socket.frame({
      t: 'events',
      events: [
        {
          kind: 'assistant',
          id: 'a1',
          ts: Date.now(),
          text: 'read [the story](https://example.com/story)',
          voice: 'reply',
        },
      ],
    }),
  );
  const a = host.querySelector<HTMLAnchorElement>('.chat-md a[href="https://example.com/story"]');
  expect(a).not.toBeNull();
  expect(host.querySelector('[data-testid=link-sheet]')).toBeNull();
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    a!.dispatchEvent(ev);
  });
  expect(ev.defaultPrevented).toBe(true);
  expect(host.querySelector('[data-testid=link-sheet]')?.getAttribute('data-testid')).toBe(
    'link-sheet',
  );
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/browsers/links/open', expect.anything());
});
