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
    root!.render(<ChatPane paneId="recovery-pane" tabId="recovery-tab" active agentNative />),
  );
  const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/recovery-pane'))!;
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
const draft = () => host.querySelector<HTMLElement>('.chat-input')!;
async function type(text: string) {
  await act(async () => {
    draft().textContent = text;
    draft().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it.each([
  { edited: false, reconnect: false },
  { edited: true, reconnect: false },
  { edited: false, reconnect: true },
  { edited: true, reconnect: true },
])(
  'reconciles socket-close recovery: $edited edits, $reconnect reconnect',
  async ({ edited, reconnect }) => {
    const socket = await setup();
    await type('hello');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
    expect(socket.sent).toContainEqual({ t: 'send', text: 'hello' });
    expect(draft().textContent).toBe('');
    await act(async () => {
      socket.close();
      socket.onclose?.();
    });
    expect(draft().textContent).toBe('hello');
    expect(host.textContent).toContain('Connection dropped before the message was sent');
    if (edited) await type('hello and more');
    if (reconnect) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const next = Socket.instances.filter((s) => s.url.endsWith('/ws/chat/recovery-pane')).at(-1)!;
      expect(next).not.toBe(socket);
      await act(async () => {
        next.readyState = Socket.OPEN;
        next.onopen?.();
        // THE TEXT MATTERS. A bare turn-start means "a turn nobody here
        // started" — a cron, a queue drain — and must NOT clear a composer
        // holding an undelivered message. Asserting recovery on a bare frame
        // is what locked that bug in; this names the send it is evidence for.
        next.frame({ t: 'turn-start', text: 'hello' });
      });
    } else {
      await act(async () => socket.frame({ t: 'send-ack' }));
    }
    expect(draft().textContent).toBe(edited ? 'hello and more' : '');
    expect(host.textContent).not.toContain('Connection dropped before the message was sent');
  },
);

it('a turn that nobody here started does not empty the composer', async () => {
  // THE REGRESSION THE BARE FRAME ABOVE USED TO HIDE. A restored message sits
  // in the composer until something proves it arrived. A cron fire, a wakeup,
  // or the queue draining another message broadcasts a turn-start with NO
  // text — "this one isn't yours" — and clearing on that lost a message the
  // server never received, silently, along with the notice saying so.
  const socket = await setup();
  await type('hello');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  await act(async () => {
    socket.close();
    socket.onclose?.();
  });
  expect(draft().textContent).toBe('hello');

  await act(async () => socket.frame({ t: 'turn-start' }));
  expect(draft().textContent).toBe('hello');
  expect(host.textContent).toContain('Connection dropped before the message was sent');

  // A turn-start naming a DIFFERENT message is equally not ours.
  await act(async () => socket.frame({ t: 'turn-start', text: 'something else' }));
  expect(draft().textContent).toBe('hello');

  // Only the one that names it counts.
  await act(async () => socket.frame({ t: 'turn-start', text: 'hello' }));
  expect(draft().textContent).toBe('');
});
