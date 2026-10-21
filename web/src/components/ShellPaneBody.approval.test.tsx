vi.mock('../lib/slack-passkey', () => ({
  passkeyAPI: vi.fn(async () => ({ mode: 'legacy' })),
  passkeyCeremony: vi.fn(),
}));
import type { PaneSpec } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ShellPaneBody } from './ShellPaneBody';
vi.mock('./ChatPane', () => ({ ChatPane: () => null }));
vi.mock('./XtermPane', () => ({ XtermPane: () => null }));
vi.mock('../lib/pane-face', () => ({
  usePaneFace: (_id: string, face: string) => ({ face, url: null }),
  isSelfOriginUrl: () => false,
  setPaneFace: vi.fn(),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const pane = (id: string, face = 'terminal') =>
  ({ id, tab_id: `tab-${id}`, face, startup_cmd: '' }) as PaneSpec;
it('mounts terminal notices only inside visible owning panes; inactive mobile/tab panes never poll', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let pendingB = 0;
  const fetchMock = vi.fn(async (path: string) => {
    const id = new URL(path, 'https://muxpad.test').searchParams.get('pane');
    return {
      ok: true,
      json: async () => ({
        pane: id,
        pending: id === 'a' ? 1 : pendingB,
        approval_url: 'https://broker.test/review',
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = async (active: string) =>
    act(async () =>
      root.render(
        <>
          <section data-pane="a">
            <ShellPaneBody pane={pane('a')} onExit={() => {}} paneActive={active === 'a'} />
          </section>
          <section data-pane="b">
            <ShellPaneBody
              pane={pane('b', 'terminal')}
              onExit={() => {}}
              paneActive={active === 'b'}
            />
          </section>
        </>,
      ),
    );
  await render('a');
  expect(host.querySelector('[data-pane="a"] output')?.textContent).toContain(
    'Slack approval needed',
  );
  expect(host.querySelector('[data-pane="b"] output')).toBeNull();
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/slack/approvals?pane=a']);
  await render('b');
  expect(host.querySelectorAll('output')).toHaveLength(0);
  pendingB = 1;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(host.querySelector('[data-pane="a"] output')).toBeNull();
  expect(host.querySelector('[data-pane="b"] output')?.textContent).toContain(
    'Slack approval needed',
  );
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('pane=a'))).toHaveLength(1);
  await render('neither');
  const calls = fetchMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(host.querySelectorAll('output')).toHaveLength(0);
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it('keeps simultaneous desktop panes independent instead of sharing one global banner', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const id = new URL(path, 'https://muxpad.test').searchParams.get('pane');
      return {
        ok: true,
        json: async () => ({
          pane: id,
          pending: id === 'a' ? 1 : 0,
          approval_url: 'https://broker.test/review',
        }),
      };
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <>
        <section data-pane="a">
          <ShellPaneBody pane={pane('a')} onExit={() => {}} paneActive />
        </section>
        <section data-pane="b">
          <ShellPaneBody pane={pane('b')} onExit={() => {}} paneActive />
        </section>
      </>,
    ),
  );
  expect(host.querySelector('[data-pane="a"] output')).not.toBeNull();
  expect(host.querySelector('[data-pane="b"] output')).toBeNull();
  expect(host.querySelectorAll('.slack-approval-review')).toHaveLength(1);
  expect(host.querySelector('a')?.textContent).toBe('Review');
});
