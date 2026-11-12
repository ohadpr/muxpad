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
async function setup(agentNative = true, session: unknown = null, connect = true) {
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
    root!.render(<ChatPane paneId="new-pane" tabId="new-tab" active agentNative={agentNative} />),
  );
  const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/new-pane'))!;
  if (!connect) return socket;
  await act(async () => {
    socket.readyState = Socket.OPEN;
    socket.onopen?.();
    socket.frame({
      t: 'session',
      mode: 'chat',
      hasMessages: false,
      turnRunning: false,
      session,
    });
  });
  return socket;
}
const draft = () => host.querySelector<HTMLElement>('.chat-input');
async function type(text: string) {
  await act(async () => {
    const d = draft()!;
    d.textContent = text;
    d.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// A NEW CHAT IS TYPEABLE BEFORE ITS AGENT HAS BOOTED.
//
// The composer used to mount on the runner's hello (`session.current_sid`), so
// a brand-new chat showed "Starting…" and no field for the whole boot —
// measured 3.2–3.9 s from the click on the live install. The server already
// queues a send for a runner-owned pane with no runner and drains it on hello,
// so the composer opens at once and the first message waits in that queue.
it('opens the composer while the agent is still starting, and queues the first send', async () => {
  const socket = await setup();
  expect(host.textContent).toContain('Starting…');
  expect(draft()).not.toBeNull();
  await type('hello');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  expect(socket.sent).toContainEqual({ t: 'send', text: 'hello' });
  // Handed to the server queue, not drawn as a turn already running: no
  // optimistic echo, no working row, until the queue frame or hello says so.
  expect(host.querySelector('.chat-working')).toBeNull();
});

it('is open while the socket is still connecting', async () => {
  await setup(true, null, false);
  expect(host.textContent).toContain('Connecting…');
  expect(draft()).not.toBeNull();
});

it('closes again once the grace runs out with no runner (Start agent takes over)', async () => {
  await setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8100);
  });
  expect(draft()).toBeNull();
  expect(host.textContent).toContain('Start agent');
});

it('stays shut for a pane that is not runner-owned', async () => {
  await setup(false);
  expect(draft()).toBeNull();
});
