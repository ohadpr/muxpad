import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageModal, type MediaItem, UserText } from './ChatTranscript';

/**
 * The lightbox, and the two things reported about it:
 *
 *   1. a single image opened CUT OFF — it was fitted to `window`, but its
 *      backdrop is `position: absolute` inside the chat pane, which with a
 *      sidebar open is hundreds of pixels narrower. The fit must be measured
 *      against the stage it actually renders in.
 *   2. a message with three screenshots dead-ended on whichever one you tapped.
 *      The modal now carries the set, so ← → and a swipe move inside it.
 *
 * jsdom has no layout, so the fit arithmetic itself is not observable here —
 * what IS observable, and what actually regressed, is the structure: that the
 * image is inside the measured stage rather than a sibling of it, and that the
 * navigation exists, wraps, and stays off the picture.
 */
// jsdom ships no ResizeObserver, and the stage is observed so a pane resize
// re-fits the image. A no-op stub is enough: nothing here asserts on layout,
// which jsdom could not produce anyway.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const IMG = (n: number): MediaItem => ({
  url: `/a/${n}.png`,
  name: `shot ${n}`,
  video: false,
});

function mount(items: MediaItem[], index = 0) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const onIndex = vi.fn();
  const render = (at: number) =>
    act(() => {
      root.render(<ImageModal items={items} index={at} onIndex={onIndex} onClose={onClose} />);
    });
  render(index);
  return { host, root, onClose, onIndex, render };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the lightbox', () => {
  it('puts the image INSIDE the stage that gets measured', () => {
    // The fit bug in structural form: ZoomableImage measures
    // `imgRef.parentElement`, so the image being a child of the stage — and
    // the stage being the padded box — is the contract. An image reparented
    // out of it silently goes back to being fitted against the window.
    const { host } = mount([IMG(1)]);
    const img = host.querySelector('img.chat-img-full');
    expect(img).toBeTruthy();
    // The FRAME, specifically — the box with a size of its own. Measuring the
    // stage instead let the image define its own limit (see .chat-img-frame).
    expect(img?.parentElement?.className).toContain('chat-img-frame');
  });

  it('shows no navigation for a lone image', () => {
    const { host } = mount([IMG(1)]);
    expect(host.querySelector('.chat-img-nav')).toBeNull();
  });

  it('shows arrows and a position for several', () => {
    const { host } = mount([IMG(1), IMG(2), IMG(3)], 1);
    expect(host.querySelector('.chat-img-nav')).toBeTruthy();
    expect(host.querySelector('.chat-img-count')?.textContent).toBe('2 / 3');
    expect(host.querySelectorAll('.chat-img-arrow')).toHaveLength(2);
  });

  it('the nav is a SIBLING of the image, never on top of it', () => {
    // An arrow floating over the picture covers the part you opened it to see.
    const { host } = mount([IMG(1), IMG(2)]);
    const nav = host.querySelector('.chat-img-nav');
    const frame = host.querySelector('.chat-img-frame');
    // Siblings inside the stage: the nav sits BELOW the frame, never over it.
    expect(nav?.parentElement).toBe(frame?.parentElement);
    expect(nav?.previousElementSibling).toBe(frame);
  });

  it('steps forward and back', () => {
    const { host, onIndex } = mount([IMG(1), IMG(2), IMG(3)], 1);
    const [prev, next] = [...host.querySelectorAll('.chat-img-arrow')] as HTMLButtonElement[];
    act(() => next?.click());
    expect(onIndex).toHaveBeenLastCalledWith(2);
    act(() => prev?.click());
    expect(onIndex).toHaveBeenLastCalledWith(0);
  });

  it('wraps at both ends, so an arrow is never dead', () => {
    const { host, onIndex } = mount([IMG(1), IMG(2), IMG(3)], 2);
    const [prev, next] = [...host.querySelectorAll('.chat-img-arrow')] as HTMLButtonElement[];
    act(() => next?.click());
    expect(onIndex).toHaveBeenLastCalledWith(0); // last → first

    const b = mount([IMG(1), IMG(2), IMG(3)], 0);
    const [prev2] = [...b.host.querySelectorAll('.chat-img-arrow')] as HTMLButtonElement[];
    act(() => prev2?.click());
    expect(b.onIndex).toHaveBeenLastCalledWith(2); // first → last
    void prev;
  });

  it('← and → move; Escape still closes', () => {
    const { onIndex, onClose } = mount([IMG(1), IMG(2), IMG(3)], 0);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(onIndex).toHaveBeenLastCalledWith(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    expect(onIndex).toHaveBeenLastCalledWith(2); // wrapped back off 0
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('an arrow key on a LONE image does nothing', () => {
    const { onIndex } = mount([IMG(1)]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(onIndex).not.toHaveBeenCalled();
  });

  it('remounts the image on a step, so zoom and pan do not carry over', () => {
    // Keyed on the url: without it React reuses the element and you arrive at
    // the next picture already scrolled into the previous one's corner.
    const { host, render } = mount([IMG(1), IMG(2)], 0);
    const first = host.querySelector('img.chat-img-full');
    render(1);
    const second = host.querySelector('img.chat-img-full');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(second?.getAttribute('src')).toBe('/a/2.png');
  });

  it('survives an index past the end of the set', () => {
    // The list and the index are two pieces of state; a stale pair must not
    // render a blank modal.
    const { host } = mount([IMG(1), IMG(2)], 9);
    expect(host.querySelector('img.chat-img-full')?.getAttribute('src')).toBe('/a/2.png');
  });

  it('renders a video item as a video, not an image', () => {
    const { host } = mount([{ url: '/a/clip.mp4', name: 'clip', video: true }]);
    expect(host.querySelector('video.chat-img-full')).toBeTruthy();
    expect(host.querySelector('img.chat-img-full')).toBeNull();
  });
});

/**
 * WHICH IMAGES COUNT AS "SEVERAL" — the grouping the arrows depend on.
 *
 * Layout groups media by contiguous RUN: any text between two images flushes
 * the gallery. Navigation must not, or the reported case — three screenshots
 * with a sentence between them — opens a lightbox with nowhere to go. Measured
 * on the real message before this: 3 thumbnails, 0 galleries.
 */
describe('what the lightbox is given to navigate', () => {
  const shot = (n: number) => `/Users/x/.muxpad/attachments/shot${n}.png`;

  function mountText(text: string) {
    const host = document.createElement('div');
    document.body.append(host);
    const onOpenImage = vi.fn();
    act(() => {
      createRoot(host).render(<UserText text={text} onOpenImage={onOpenImage} />);
    });
    return { host, onOpenImage };
  }

  it('hands over EVERY image in the message, even with prose between them', () => {
    const { host, onOpenImage } = mountText(
      `first ${shot(1)} then some words ${shot(2)} and more ${shot(3)}`,
    );
    const thumbs = [...host.querySelectorAll('.chat-img-thumb, .chat-gallery-item')];
    // Three separate runs → three separate single thumbnails. That is layout.
    expect(thumbs).toHaveLength(3);

    act(() => (thumbs[1] as HTMLButtonElement).click());
    const arg = onOpenImage.mock.calls.at(-1)?.[0];
    // …but the SET is the whole message, opened on the one that was tapped.
    expect(arg.items).toHaveLength(3);
    expect(arg.index).toBe(1);
    expect(arg.items[1].url).toContain('shot2.png');
  });

  it('indexes correctly when a run of several is followed by more', () => {
    // Adjacent images render as a grid; the offset must still place a click
    // from a LATER run at its true position in the message.
    const { host, onOpenImage } = mountText(`${shot(1)} ${shot(2)} words then ${shot(3)}`);
    const thumbs = [...host.querySelectorAll('.chat-img-thumb, .chat-gallery-item')];
    expect(thumbs).toHaveLength(3);
    act(() => (thumbs[2] as HTMLButtonElement).click());
    const arg = onOpenImage.mock.calls.at(-1)?.[0];
    expect(arg.items).toHaveLength(3);
    expect(arg.index).toBe(2);
    expect(arg.items[2].url).toContain('shot3.png');
  });

  it('a lone image still opens a set of one', () => {
    const { host, onOpenImage } = mountText(`just this ${shot(1)}`);
    act(() => (host.querySelector('.chat-img-thumb') as HTMLButtonElement).click());
    const arg = onOpenImage.mock.calls.at(-1)?.[0];
    expect(arg.items).toHaveLength(1);
    expect(arg.index).toBe(0);
  });
});
