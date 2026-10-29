import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyablePre } from './CopyablePre';

/**
 * LINES THAT RUN OFF THE EDGE CAN BE ASKED TO WRAP.
 *
 * A block keeps `white-space: pre`, which is right for code — indentation is
 * meaning, and a desktop has a scrollbar. It is wrong for what these blocks
 * actually hold most of the time: an email, a prompt, a paragraph, where the
 * sentence disappears past the right edge and reading it means dragging a bar
 * one screen at a time. "Add another button next to copy which collapses
 * overflowed lines, so it's easier to read the whole text if needed."
 */
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

/** jsdom lays nothing out, so overflow has to be declared by the fixture:
 *  `scrollWidth` and `clientWidth` are both 0 unless we say otherwise. */
function withOverflow(overflowing: boolean) {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return overflowing ? 900 : 300;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 300;
    },
  });
}

const mount = (text: string) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<CopyablePre>{text}</CopyablePre>);
  });
  return host;
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

describe('the wrap toggle', () => {
  it('is absent when nothing runs off the edge', () => {
    // A control that does nothing is worse than no control: it is one of two
    // things in that corner, and a reader will press it once.
    withOverflow(false);
    const box = mount('short');
    expect(box.querySelector('.copyable-block-wrap')).toBeNull();
    // …and copy is still there, which is the one that never moves.
    expect(box.querySelectorAll('.copyable-block-button')).toHaveLength(1);
  });

  it('appears beside copy when the block overflows', () => {
    withOverflow(true);
    const box = mount('a very long line that runs past the right-hand edge of the block');
    const wrap = box.querySelector('.copyable-block-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap?.getAttribute('aria-pressed')).toBe('false');
    // Before copy in the DOM, so copy keeps its position at the corner.
    const buttons = [...box.querySelectorAll('.copyable-block-button')];
    expect(buttons[0]).toBe(wrap);
  });

  it('wraps the block, and says it is pressed', () => {
    withOverflow(true);
    const box = mount('a very long line');
    act(() => {
      box.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    expect(box.querySelector('pre')?.dataset.wrap).toBe('true');
    expect(box.querySelector('.copyable-block-wrap')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('stays reachable once pressed, even though wrapping ends the overflow', () => {
    // The measurement that put the button there stops being true the moment
    // it works. Without this the control would vanish under the pointer and
    // the reader could never turn it back off.
    withOverflow(true);
    const box = mount('a very long line');
    act(() => {
      box.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    withOverflow(false);
    act(() => {
      box.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    expect(box.querySelector('pre')?.dataset.wrap).toBeUndefined();
  });

  it('is per block, not a setting', () => {
    // Two blocks, one pressed: the other is untouched. The default stays the
    // one that is right for code.
    withOverflow(true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <>
          <CopyablePre>one</CopyablePre>
          <CopyablePre>two</CopyablePre>
        </>,
      );
    });
    const [first, second] = [...host.querySelectorAll('.copyable-block')];
    act(() => {
      first?.querySelector<HTMLButtonElement>('.copyable-block-wrap')?.click();
    });
    expect(first?.querySelector('pre')?.dataset.wrap).toBe('true');
    expect(second?.querySelector('pre')?.dataset.wrap).toBeUndefined();
  });
});
