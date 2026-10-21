import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useArmed } from './use-armed';

/**
 * The confirmation mechanism that replaced `window.confirm` across the chrome.
 * Tested on its own because five controls share it, and the property that
 * matters most is the one a click-through test never exercises: a control left
 * armed behind you must stop being armed.
 */
describe('useArmed', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let acted: number[];

  function Probe({ ms }: { ms?: number }) {
    const { armed, press, disarm } = useArmed(ms);
    return (
      <>
        <button
          type="button"
          id="act"
          data-armed={armed}
          onClick={() => {
            if (press()) acted.push(Date.now());
          }}
        >
          {armed ? 'again?' : 'do it'}
        </button>
        <button type="button" id="away" onClick={disarm}>
          away
        </button>
      </>
    );
  }
  const btn = () => host.querySelector('#act') as HTMLButtonElement;
  const click = async (el: Element | null) =>
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

  beforeEach(() => {
    vi.useFakeTimers();
    acted = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Probe />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('does nothing on the first press, and acts on the second', async () => {
    await click(btn());
    expect(acted).toHaveLength(0);
    expect(btn().dataset.armed).toBe('true');
    expect(btn().textContent).toBe('again?');
    await click(btn());
    expect(acted).toHaveLength(1);
  });

  it('disarms after it acts — the next press asks again', async () => {
    await click(btn());
    await click(btn());
    expect(btn().dataset.armed).toBe('false');
    await click(btn());
    expect(acted).toHaveLength(1);
  });

  it('disarms on its own, so a control you walked away from is safe', async () => {
    await click(btn());
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(btn().dataset.armed).toBe('false');
    // The press that follows is a FIRST press again, not the confirmation.
    await click(btn());
    expect(acted).toHaveLength(0);
  });

  it('disarms when the caller says so (pointer left, or blur)', async () => {
    await click(btn());
    await click(host.querySelector('#away'));
    expect(btn().dataset.armed).toBe('false');
  });
});
