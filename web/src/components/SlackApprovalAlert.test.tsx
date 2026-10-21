vi.mock('../lib/slack-passkey', () => ({
  passkeyAPI: vi.fn(async () => ({ mode: 'legacy' })),
  passkeyCeremony: vi.fn(),
}));
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SlackApprovalAlert } from './SlackApprovalAlert';
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('automatically shows requests, recovers a hung poll, opens only on Review and clears after completion', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let pending = 0;
  let hung = false;
  const fetchMock = vi.fn(async (_path: string, _options?: RequestInit) => {
    if (hung) return new Promise<never>(() => {});
    return {
      ok: true,
      json: async () => ({ pane: 'pane-a', pending, approval_url: 'https://broker.test/review' }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SlackApprovalAlert paneId="pane-a" />));
  expect(host.textContent).toBe('');
  pending = 1;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(host.textContent).toContain('Slack approval needed');
  expect(host.querySelector('svg[role=img]')?.getAttribute('aria-label')).toBe('Slack');
  expect(open).not.toHaveBeenCalled();
  expect(host.querySelector('a')?.href).toBe('https://broker.test/review');
  expect(host.querySelector('a')?.target).toBe('_blank');
  expect(host.querySelector('a')?.rel).toBe('noopener noreferrer');
  expect(open).not.toHaveBeenCalled();
  hung = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(host.textContent).toContain('Reconnecting');
  hung = false;
  pending = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(host.textContent).toBe('');
  expect(
    fetchMock.mock.calls.every(
      ([path, options]) => path === '/api/slack/approvals?pane=pane-a' && !options?.method,
    ),
  ).toBe(true);
});

it('shows an initial outage without inventing a trusted approval destination, then recovers', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let hung = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      hung
        ? new Promise<never>(() => {})
        : {
            ok: true,
            json: async () => ({
              pane: 'pane-a',
              pending: 0,
              approval_url: 'https://broker.test/review',
            }),
          },
    ),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SlackApprovalAlert paneId="pane-a" />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(host.textContent).toBe('');
  expect(host.querySelector('button')).toBeNull();
  expect(host.querySelector('a')).toBeNull();
  hung = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(host.textContent).toBe('');
});

it('does not display or accept another pane’s status response', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        pane: 'pane-b',
        pending: 1,
        approval_url: 'https://broker.test/review',
      }),
    })),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SlackApprovalAlert paneId="pane-a" />));
  expect(host.textContent).toBe('');
});

it('does not carry a previous pane notice across a pane change or late response', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolveB: (value: unknown) => void = () => {};
  const fetchMock = vi.fn(async (path: string) =>
    path.endsWith('pane-a')
      ? {
          ok: true,
          json: async () => ({
            pane: 'pane-a',
            pending: 1,
            approval_url: 'https://broker.test/review',
          }),
        }
      : new Promise((resolve) => {
          resolveB = resolve;
        }),
  );
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SlackApprovalAlert paneId="pane-a" />));
  expect(host.textContent).toContain('Slack approval needed');
  await act(async () => root.render(<SlackApprovalAlert paneId="pane-b" />));
  expect(host.textContent).toBe('');
  await act(async () => root.render(<SlackApprovalAlert paneId="pane-a" />));
  await act(async () =>
    resolveB({
      ok: true,
      json: async () => ({
        pane: 'pane-b',
        pending: 9,
        approval_url: 'https://broker.test/review',
      }),
    }),
  );
  expect(host.textContent).toContain('Slack approval needed');
  expect(host.textContent).not.toContain('(9)');
});

it.each([
  { initial: 0, cleared: false, visible: false },
  { initial: 1, cleared: false, visible: true },
  { initial: 1, cleared: true, visible: false },
])(
  'requires scoped pending evidence during an outage: %j',
  async ({ initial, cleared, visible }) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let pending = initial;
    let failed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (failed) throw Error('Network unavailable');
        return {
          ok: true,
          json: async () => ({
            pane: 'pane-a',
            pending,
            approval_url: 'https://broker.test/review',
          }),
        };
      }),
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<SlackApprovalAlert paneId="pane-a" />));
    if (cleared) {
      pending = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }
    failed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(host.querySelector('a') !== null).toBe(visible);
    if (visible) expect(host.textContent).toContain('Reconnecting');
    else expect(host.textContent).toBe('');
  },
);
