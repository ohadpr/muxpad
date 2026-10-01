import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { setTabViewMode, useTabViewMode } from './tab-view-mode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../api', () => ({ api: { patchTab: async () => ({}) } }));

it('eventually applies a remote flip received inside the local grace window', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe({ server }: { server: 'split' | 'tabbed' }) {
    const mode = useTabViewMode('remote-during-grace', server);
    return <span>{mode}</span>;
  }
  try {
    act(() => root.render(<Probe server="split" />));
    act(() => setTabViewMode('remote-during-grace', 'tabbed'));
    // Our echo confirms tabbed; another client flips back one second later.
    act(() => root.render(<Probe server="tabbed" />));
    act(() => vi.advanceTimersByTime(1000));
    act(() => root.render(<Probe server="split" />));
    act(() => vi.advanceTimersByTime(4001));
    expect(host.textContent).toBe('split');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
