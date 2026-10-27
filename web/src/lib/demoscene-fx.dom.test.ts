// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DROP_MIN_DISTANCE_PX, WATCHDOG_MS, installDemosceneFx } from './demoscene-fx';

/**
 * THE TEXT MUST ALWAYS COME BACK.
 *
 * Reported with a screenshot: "the text above remains garbled in the bullet
 * list". Damage is applied in one frame and undone in the NEXT, so anything
 * that stops the next frame leaves corrupted characters on screen for good —
 * an exception, the tab being hidden, the theme changing mid-ripple. The
 * effect is an ornament; the text is the product, and the product cannot be
 * the thing that breaks.
 *
 * These drive the real installer against a real (jsdom) document, because the
 * failure is entirely in the lifecycle — the pure functions were all correct
 * while this bug was live.
 */
const GLYPHS = '░▒▓█▄▀▌▐│─┼╬╔╗╚╝═║◆◢◣▲▼<>/\\|*+=#@$%&';
const hasGlyph = (s: string) => [...s].some((c) => GLYPHS.includes(c));

let teardown: (() => void) | null = null;

function build(): HTMLElement {
  document.body.innerHTML = '';
  document.documentElement.dataset.theme = 'demoscene';
  const list = document.createElement('div');
  list.className = 'chat-list';
  const msg = document.createElement('div');
  msg.className = 'chat-msg';
  const li = document.createElement('li');
  li.textContent = 'the quick brown fox jumps over the lazy dog, repeatedly and at length';
  msg.appendChild(li);
  list.appendChild(msg);
  document.body.appendChild(list);
  // jsdom gives every element a zero rect; the effect culls on geometry, so
  // put a real box on it.
  li.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 600, bottom: 40, width: 600, height: 40, x: 0, y: 0 }) as DOMRect;
  return li;
}

/**
 * Watches a node for EVER having been corrupted.
 *
 * Without this every test here is vacuous: they assert the text is clean at
 * the end, and the text is clean at the end whether or not damage ever
 * happened. Both guards below were mutated out and all five still passed
 * before this existed — so the observer is the part that makes them tests.
 */
function watchDamage(el: HTMLElement): { everDamaged: () => boolean; stop: () => void } {
  let seen = false;
  const obs = new MutationObserver(() => {
    if (hasGlyph(el.textContent ?? '')) seen = true;
  });
  obs.observe(el, { characterData: true, subtree: true, childList: true });
  return { everDamaged: () => seen, stop: () => obs.disconnect() };
}

/**
 * Ripple until the node is actually damaged, or give up.
 *
 * Corruption is probabilistic per character per frame, so one frame is not
 * guaranteed to touch anything — a test that assumed it did would be flaky in
 * exactly the direction that hides bugs.
 */
async function rippleUntilDamaged(w: { everDamaged: () => boolean }, tries = 40) {
  for (let i = 0; i < tries && !w.everDamaged(); i++) {
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 20 + (i % 2) * DROP_MIN_DISTANCE_PX * 2,
        clientY: 20,
        bubbles: true,
      }),
    );
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
}

beforeEach(() => {
  vi.useRealTimers();
  // jsdom ships no matchMedia; the installer asks it about reduced motion.
  if (!window.matchMedia)
    window.matchMedia = ((q: string) =>
      ({
        matches: false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
});

describe('damaged text is always put back', () => {
  it('restores when the theme is turned off mid-ripple', async () => {
    const li = build();
    const pristine = li.textContent as string;
    teardown = installDemosceneFx(document);
    const w = watchDamage(li);
    await rippleUntilDamaged(w);
    expect(w.everDamaged(), 'nothing was ever corrupted — the test proves nothing').toBe(true);

    document.documentElement.dataset.theme = 'dracula';
    await new Promise((r) => setTimeout(r, 20));
    w.stop();
    expect(hasGlyph(li.textContent ?? '')).toBe(false);
    expect(li.textContent).toBe(pristine);
  });

  it('restores on teardown, however mid-flight it is', async () => {
    const li = build();
    const pristine = li.textContent as string;
    const stop = installDemosceneFx(document);
    const w = watchDamage(li);
    await rippleUntilDamaged(w);
    expect(w.everDamaged()).toBe(true);
    stop();
    w.stop();
    expect(li.textContent).toBe(pristine);
  });

  it('restores when the tab is hidden — a hidden tab gets no frames', async () => {
    const li = build();
    const pristine = li.textContent as string;
    teardown = installDemosceneFx(document);
    const w = watchDamage(li);
    await rippleUntilDamaged(w);
    expect(w.everDamaged()).toBe(true);

    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    w.stop();
    expect(li.textContent).toBe(pristine);
  });

  it('has a watchdog, so no further frame still means no lasting damage', async () => {
    const li = build();
    const pristine = li.textContent as string;
    teardown = installDemosceneFx(document);
    const w = watchDamage(li);
    await rippleUntilDamaged(w);
    expect(w.everDamaged()).toBe(true);
    // Now starve it of frames entirely — the exact shape of "the next frame
    // never came", which is what left a bullet list permanently garbled.
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => 0) as typeof raf;
    expect(hasGlyph(li.textContent ?? ''), 'nothing to recover from').toBe(true);
    await new Promise((r) => setTimeout(r, WATCHDOG_MS + 200));
    globalThis.requestAnimationFrame = raf;
    w.stop();
    expect(hasGlyph(li.textContent ?? '')).toBe(false);
    expect(li.textContent).toBe(pristine);
  });

  it('does NOT clobber text somebody else changed while it was damaged', async () => {
    // A streaming message rewrites its own nodes. Blindly restoring would undo
    // a real update — the other way this corrupts a conversation.
    const li = build();
    teardown = installDemosceneFx(document);
    const w = watchDamage(li);
    await rippleUntilDamaged(w);
    expect(w.everDamaged()).toBe(true);
    w.stop();

    const streamed = 'brand new streamed content that arrived mid-ripple';
    (li.firstChild as Text).nodeValue = streamed;
    document.documentElement.dataset.theme = 'dracula';
    await new Promise((r) => setTimeout(r, 20));
    expect(li.textContent).toBe(streamed);
  });
});
