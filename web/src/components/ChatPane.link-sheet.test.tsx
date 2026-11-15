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
  // THE SHEET IS A PHONE AFFORDANCE, so this suite is a phone. A stub that
  // answered `false` to every query made these tests DESKTOP, where a link is
  // now a new tab — which is why they are explicit about the layout.
  setLayout(true);
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

/** Answer the mobile media query, and nothing else. */
function setLayout(mobile: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: mobile && q.includes('max-width'),
    addEventListener() {},
    removeEventListener() {},
  }));
}

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
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/open/frame?'))).toBe(
    true,
  );
});

it('an http link on an https muxpad is left to the OS browser — mixed content never frames', async () => {
  vi.stubGlobal('location', { ...window.location, origin: 'https://muxpad.example' });
  const socket = await setup();
  await act(async () =>
    socket.frame({
      t: 'events',
      events: [
        {
          kind: 'assistant',
          id: 'a2',
          ts: Date.now(),
          text: 'open [the app](http://example-host:4760)',
          voice: 'reply',
        },
      ],
    }),
  );
  const a = host.querySelector<HTMLAnchorElement>('.chat-md a[href="http://example-host:4760"]');
  expect(a).not.toBeNull();
  expect(a!.getAttribute('target')).toBe('_blank');
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    a!.dispatchEvent(ev);
  });
  expect(ev.defaultPrevented).toBe(false);
  expect(host.querySelector('[data-testid=link-sheet]')).toBeNull();
});

/**
 * ── ON DESKTOP, A LINK IS A NEW TAB ───────────────────────────────────────
 *
 * The sheet exists so a phone does not feel like it left the app. A desktop
 * already has tabs, a back button and two windows side by side, and a sheet
 * over the conversation takes those away to simulate them worse. Asked for
 * directly: "on desktop links should always open in a new tab."
 *
 * Same markup, same framable https url as the passing test above — only the
 * layout differs, so this fails if the layout stops being consulted.
 */
it('leaves a link alone on desktop, so the browser opens its own tab', async () => {
  setLayout(false);
  const socket = await setup();
  await act(async () =>
    socket.frame({
      t: 'events',
      events: [
        {
          kind: 'assistant',
          id: 'a3',
          ts: Date.now(),
          text: 'read [the story](https://example.com/story)',
          voice: 'reply',
        },
      ],
    }),
  );
  const a = host.querySelector<HTMLAnchorElement>('.chat-md a[href="https://example.com/story"]');
  expect(a).not.toBeNull();
  expect(a!.getAttribute('target')).toBe('_blank');
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    a!.dispatchEvent(ev);
  });
  // NOT prevented: the anchor's own target=_blank is what opens the tab, from
  // inside the tap, where no popup blocker objects.
  expect(ev.defaultPrevented).toBe(false);
  expect(host.querySelector('[data-testid=link-sheet]')).toBeNull();
});
