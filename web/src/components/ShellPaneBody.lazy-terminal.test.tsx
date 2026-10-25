import type { PaneSpec } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ShellPaneBody } from './ShellPaneBody';

/**
 * THE TERMINAL IS LAZY NOW, AND A LAZY IMPORT CAN BE SILENTLY WRONG.
 *
 * `@xterm/*` is ~316 KB raw — a quarter of the main bundle's parse cost, on a
 * phone, in front of a chat that may never show a terminal. So XtermPane is
 * behind `lazy()` and a Suspense boundary whose fallback is `null`.
 *
 * That fallback is the hazard this test exists for: a wrong path, a renamed
 * export or a chunk that fails to load does not throw anywhere a human looks —
 * it renders NOTHING, for ever, and the terminal face is simply blank. The
 * only way to know the boundary resolves is to let it.
 */
vi.mock('./ChatPane', () => ({ ChatPane: () => null }));
vi.mock('../lib/pane-face', () => ({
  usePaneFace: (_id: string, face: string) => ({ face, url: null }),
  isSelfOriginUrl: () => false,
  setPaneFace: vi.fn(),
}));
vi.mock('../lib/slack-passkey', () => ({
  passkeyAPI: vi.fn(async () => ({ mode: 'legacy' })),
  passkeyCeremony: vi.fn(),
}));
// Stands in for the real module at the SAME specifier the lazy import uses, so
// a typo in that specifier fails here rather than shipping a blank pane.
vi.mock('./XtermPane', () => ({
  XtermPane: ({ paneId }: { paneId: string }) => <div data-testid="xterm" data-pane={paneId} />,
}));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

const pane = (id: string, face = 'terminal') =>
  ({ id, tab_id: `tab-${id}`, face, startup_cmd: '' }) as PaneSpec;

it('resolves the lazy terminal and mounts it in the terminal face', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ShellPaneBody pane={pane('a')} paneActive onExit={() => {}} />);
  });
  // Suspense has to have RESOLVED — `null` here is what a broken dynamic
  // import looks like, and it is indistinguishable from "still loading".
  const term = host.querySelector('[data-testid="xterm"]');
  expect(term, 'the lazy terminal never resolved — the face would be blank').not.toBeNull();
  expect(term?.getAttribute('data-pane')).toBe('a');
});

it('still mounts the terminal underneath while the chat face is showing', async () => {
  // Both faces mount together on purpose: that is what keeps the socket and
  // the scrollback alive so flipping back is instant. Splitting the bundle
  // must not quietly turn that into unmount-on-switch.
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ShellPaneBody pane={pane('b', 'chat')} paneActive onExit={() => {}} />);
  });
  expect(host.querySelector('[data-testid="xterm"]')).not.toBeNull();
});
