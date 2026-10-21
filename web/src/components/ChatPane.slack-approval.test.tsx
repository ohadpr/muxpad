import { passkeyAPI, passkeyCeremony } from '../lib/slack-passkey';
vi.mock('../lib/slack-passkey', () => ({
  passkeyAPI: vi.fn(async () => ({ mode: 'legacy' })),
  passkeyCeremony: vi.fn(),
}));
import type { PaneSpec } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ShellPaneBody } from './ShellPaneBody';
// Real ChatPane, face hook and approval components; only external boundaries
// are substituted. These tests verify placement/lifecycle, not browser geometry.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => () => {},
}));
vi.mock('./XtermPane', () => ({ XtermPane: () => null }));
class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
  addEventListener() {}
  removeEventListener() {}
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(mobile: boolean) {
  Socket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('matchMedia', () => ({
    matches: mobile,
    addEventListener() {},
    removeEventListener() {},
  }));
  const measurements: Array<{ target: Element; notify: () => void }> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe(target: Element) {
        measurements.push({ target, notify: this.callback });
      }
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
  let pending = 1;
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.startsWith('/api/slack/approvals')
        ? { pane: 'chat-approval-pane', pending, approval_url: 'https://broker.test/review' }
        : url === '/api/tabs/all'
          ? { workspaces: [] }
          : [],
  }));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  return {
    fetchMock,
    measurements,
    expire: () => {
      pending = 0;
    },
  };
}
const pane = (pick = false) =>
  ({
    id: 'chat-approval-pane',
    tab_id: 'chat-tab',
    kind: 'shell',
    face: 'chat',
    mode: 'chat',
    startup_cmd: `muxpad agent --mode chat${pick ? ' --pick' : ''}`,
  }) as PaneSpec;
const render = async (active: boolean, pick = false) =>
  act(async () =>
    root.render(<ShellPaneBody pane={pane(pick)} onExit={() => {}} paneActive={active} />),
  );
it.each([false, true])(
  'keeps one notice above the measured composer (mobile=%s), active only, and removes expired status',
  async (mobile) => {
    const f = setup(mobile);
    await render(false);
    const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/chat-approval-pane'));
    expect(socket).toBeDefined();
    await act(async () => {
      socket!.readyState = 1;
      socket!.onopen?.();
      socket!.onmessage?.({
        data: JSON.stringify({
          t: 'session',
          mode: 'chat',
          hasMessages: true,
          turnRunning: true,
          session: {
            current_sid: 'chat-session',
            writer: 'runner',
            view_mode: 'chat',
            assistant: 'claude',
          },
        }),
      });
    });
    expect(host.querySelector('.chat-pane')).not.toBeNull();
    expect(host.querySelector('[data-slack-shell-pane]')?.getAttribute('data-slack-active')).toBe(
      'false',
    );
    expect(host.querySelector('[data-slack-chat-pane]')?.getAttribute('data-slack-session')).toBe(
      'true',
    );
    expect(host.querySelectorAll('.slack-approval-alert')).toHaveLength(0);
    expect(
      f.fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/slack/approvals')),
    ).toHaveLength(0);
    await render(true);
    const wrap = host.querySelector<HTMLElement>('.chat-composer-wrap')!;
    const notice = wrap.querySelector('.slack-approval-alert');
    expect(host.querySelector('[data-slack-shell-pane]')?.getAttribute('data-slack-active')).toBe(
      'true',
    );
    expect(host.querySelector('[data-slack-chat-pane]')?.getAttribute('data-slack-active')).toBe(
      'true',
    );
    expect(notice?.getAttribute('data-slack-alert-pane')).toBe('chat-approval-pane');
    expect(notice?.textContent).toContain('Slack approval needed');
    expect(notice?.nextElementSibling?.classList.contains('chat-composer')).toBe(true);
    expect(host.querySelectorAll('.slack-approval-alert')).toHaveLength(1);
    expect(host.querySelector('.shell-pane-body > .slack-approval-alert')).toBeNull();
    expect(wrap.querySelector('.slack-approval-review')?.getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    // The existing composer observer must measure the notice together with the
    // input, then shrink the same transcript reserve when the notice disappears.
    Object.defineProperty(wrap, 'offsetHeight', {
      get: () => (wrap.querySelector('.slack-approval-alert') ? 150 : 100),
    });
    const measure = f.measurements.find((m) => m.target === wrap)!.notify;
    await act(async () => measure());
    const reserve = host.querySelector<HTMLElement>('.chat-composer-reserve')!;
    expect(reserve.style.height).toContain('164px');
    expect(reserve.style.height).toContain('--chat-keyboard-inset');
    f.expire();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(host.querySelectorAll('.slack-approval-alert')).toHaveLength(0);
    await act(async () => measure());
    expect(reserve.style.height).toContain('114px');
    await render(false);
    const calls = f.fetchMock.mock.calls.filter(([url]) =>
      url.startsWith('/api/slack/approvals'),
    ).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(
      f.fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/slack/approvals')),
    ).toHaveLength(calls);
  },
);
it('keeps one active notice inside the legacy pending-picker chat without a composer', async () => {
  setup(false);
  await render(true, true);
  expect(host.querySelector('.chat-harness-pick')).not.toBeNull();
  expect(host.querySelector('.chat-pane > .slack-approval-alert')).not.toBeNull();
  expect(host.querySelectorAll('.slack-approval-alert')).toHaveLength(1);
  expect(host.querySelector('.chat-composer-wrap')).toBeNull();
  await render(false, true);
  expect(host.querySelectorAll('.slack-approval-alert')).toHaveLength(0);
});

it('keeps approval reachable before the chat session connects, then moves it to the composer without duplication', async () => {
  setup(false);
  await render(true);
  expect(host.querySelector('.chat-pane > .slack-approval-alert')).not.toBeNull();
  expect(host.querySelectorAll('.slack-approval-alert')).toHaveLength(1);
  const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/chat-approval-pane'))!;
  await act(async () =>
    socket.onmessage?.({
      data: JSON.stringify({
        t: 'session',
        mode: 'chat',
        hasMessages: true,
        session: {
          current_sid: 'connected-chat',
          writer: 'runner',
          view_mode: 'chat',
          assistant: 'claude',
        },
      }),
    }),
  );
  expect(host.querySelector('.chat-pane > .slack-approval-alert')).toBeNull();
  expect(host.querySelector('.chat-composer-wrap > .slack-approval-alert')).not.toBeNull();
  expect(host.querySelectorAll('.slack-approval-alert')).toHaveLength(1);
});

it('actual ChatPane auto-opens inline passkey modal only in active requesting pane, without background WebAuthn', async () => {
  setup(true);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function () {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value: function () {
        this.open = false;
      },
    },
  });
  vi.mocked(passkeyAPI).mockImplementation(async (path) =>
    path === 'status'
      ? { mode: 'passkey-inline' }
      : {
          pane: 'chat-approval-pane',
          requests: [
            {
              id: 'pending',
              fingerprint: 'fp',
              action: 'slack.channels',
              teamID: 'T1',
              payload: {},
              expires: Date.now() + 300000,
              state: 'pending',
            },
          ],
          more: false,
          status: { serverNow: Date.now(), sessionExpires: null },
        },
  );
  await render(false);
  expect(host.querySelector('dialog')).toBeNull();
  await render(true);
  expect(host.querySelector('dialog')?.open).toBe(true);
  expect(passkeyCeremony).not.toHaveBeenCalled();
  expect(host.querySelector('.slack-approval-review')).toBeNull();
  await render(false);
  expect(host.querySelector('dialog')).toBeNull();
});
