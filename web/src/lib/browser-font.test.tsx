import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { browserTerminalFontSize, isBrowserZoomKey, useBrowserFontSize } from './browser-font';

afterEach(() => {
  document.documentElement.style.fontSize = '';
  vi.unstubAllGlobals();
});
it('uses the browser base size instead of a saved terminal preference', () => {
  document.documentElement.style.fontSize = '16px';
  expect(browserTerminalFontSize()).toBe(14);
  document.documentElement.style.fontSize = '24px';
  expect(browserTerminalFontSize()).toBe(21);
  document.documentElement.style.fontSize = '32px';
  expect(browserTerminalFontSize()).toBe(28);
});
it.each(['+', '=', '-', '0'])(
  'leaves browser zoom %s available under both modifier conventions',
  (key) => {
    expect(isBrowserZoomKey({ key, ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isBrowserZoomKey({ key, ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isBrowserZoomKey({ key, ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isBrowserZoomKey({ key, ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  },
);
it('does not claim terminal control keys', () => {
  expect(isBrowserZoomKey({ key: 'c', ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
});
it('updates an existing terminal measurement when the browser font changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let notify!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  function Measurement() {
    return <output>{useBrowserFontSize()}</output>;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  document.documentElement.style.fontSize = '16px';
  try {
    await act(async () => root.render(<Measurement />));
    expect(host.textContent).toBe('14');
    document.documentElement.style.fontSize = '24px';
    await act(async () => notify());
    expect(host.textContent).toBe('21');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  expect(disconnect).toHaveBeenCalledOnce();
});
