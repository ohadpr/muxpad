/**
 * How far the software keyboard reaches up into a pane, in CSS px — and the
 * wiring that keeps that number true.
 *
 * ── WHY THE CHAT COMPOSER NEEDS THIS AND THE PAGE DOES NOT ──────────────────
 * `.chat-composer-wrap` is `position: absolute; bottom: 0` of `.chat-pane`, and
 * the pane is sized in LAYOUT viewport units (`100svh`, `100lvh` in the
 * installed PWA — see main.tsx / styles.css). On iOS the layout viewport does
 * not shrink when the keyboard opens — only `visualViewport` does — so the
 * composer stays on the layout bottom, under the keyboard, and the scroller's
 * `clientHeight` never changes so the last turns are not reserved above it
 * either. `MobileInputBar` and the nav sheet already special-case exactly this
 * geometry (`sheet-viewport.ts`); chat did not.
 *
 * `MobileInputBar`'s standalone shortcut — "in an installed PWA, skip the JS,
 * iOS anchors `bottom: 0` to the keyboard on its own" — does NOT transfer here.
 * That contract is for `position: FIXED` elements. `.chat-composer-wrap` is
 * absolutely positioned inside a `100lvh` pane, which iOS gives nothing. The
 * arithmetic below is the whole mechanism in the PWA, which is why it has to
 * survive every way the keyboard can go away.
 *
 * ── WHY IT STOPPED BEING TRUE ───────────────────────────────────────────────
 * Reported as: "the keyboard causes the layout to get stuck, and it stays that
 * way until I start typing something new." Screenshot: the composer pill
 * floating a keyboard's height above the bottom of the screen with the
 * conversation ending above it and an empty band below, keyboard down.
 *
 * The first version of this wrote `--chat-keyboard-inset` from four events
 * (`visualViewport` resize/scroll, pane focusin/focusout) and nothing else. The
 * variable is a LATCH: the last write wins, forever. So any sequence whose last
 * observation is stale sticks — permanently, because nothing ever re-asserts.
 * Measured in Chromium at 393×852 with a 336px keyboard (probe in the report):
 *
 *   sequence                                              inset  want
 *   keyboard down, un-pan `scroll` fires, re-grow does not  336     0   STUCK
 *   keyboard down, the truth arrives after the 600ms window 336     0   STUCK
 *
 * Both leave a 336px empty band below the composer — the screenshot, exactly.
 * The first needs no missing event at all, only iOS's ordering: report the
 * un-pan (`offsetTop` 336 → 0) while `height` is still the keyboard-up 516, and
 * `paneBottom - (0 + 516)` is a full keyboard's worth of lift applied to a
 * screen with no keyboard on it.
 *
 * Two changes make the stuck state unreachable rather than merely less likely:
 *
 *  1. **An invariant, not a measurement.** A software keyboard cannot be up
 *     with nothing focused to raise it. So when nothing focusable-into is
 *     focused, the inset is 0 — whatever the viewport claims. A stale read can
 *     no longer outlive the focus that justified it. This is also exactly the
 *     user's "until I start typing something new": the recovery they found by
 *     hand, made automatic and immediate.
 *
 *  2. **Re-assert on everything cheap.** Page visibility and `pageshow` (an
 *     iOS PWA swiped away with the keyboard up comes back without it, and may
 *     fire no viewport event at all), window resize/orientation, and a
 *     `pointerdown` on the pane — so if a state nobody predicted ever does get
 *     latched, the very next touch clears it instead of the next focus.
 *
 * Returns 0 — i.e. the layout that shipped before any of this — with no
 * `visualViewport`, and whenever the visual viewport still reaches the pane's
 * own bottom. A chat pane has no PTY, so unlike the terminal this cannot
 * cascade into a SIGWINCH; that is why main.tsx's ban on a GLOBAL
 * visualViewport height mirror does not apply here.
 */

/** The visual viewport, reduced to what the inset is computed from. */
export interface KeyboardViewport {
  /** `visualViewport.height` — the band NOT covered by the keyboard. */
  height: number;
  /** `visualViewport.offsetTop` — iOS adds this when it scrolls a focused
   *  field into view, and the pane is positioned against the LAYOUT viewport,
   *  so it has to be added back. */
  offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', fn: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', fn: () => void): void;
}

export function keyboardInset(opts: {
  /** The pane's bottom edge, in layout-viewport coordinates. */
  paneBottom: number;
  vvOffsetTop: number;
  vvHeight: number;
  /**
   * Is something focused that can raise a software keyboard? When it is not,
   * the answer is 0 no matter what the viewport says — see (1) above. Optional
   * and defaulting to "assume yes" so the pure arithmetic can still be checked
   * on its own; the tracker always passes it.
   */
  editableFocused?: boolean;
}): number {
  if (opts.editableFocused === false) return 0;
  return Math.max(0, Math.round(opts.paneBottom - (opts.vvOffsetTop + opts.vvHeight)));
}

/**
 * `<input>` types that raise NO on-screen keyboard or picker on iOS. Everything
 * else — text, search, email, url, tel, number, date, time, and an input with
 * no type at all — does, so the list is the exclusions rather than the
 * inclusions: a type we have not thought of should default to "a keyboard may
 * be up", which is the safe side (it leaves the measurement in charge instead
 * of forcing the composer down under a keyboard that is really there).
 */
const NO_KEYBOARD_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * Could this element be the reason a software keyboard is on screen?
 *
 * `<select>` counts: iOS raises a picker wheel for one, which shrinks the
 * visual viewport exactly like a keyboard does, and forcing the inset to 0
 * underneath it would put the composer back under the wheel.
 */
export function raisesSoftKeyboard(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') {
    return !(el as HTMLTextAreaElement | HTMLSelectElement).disabled;
  }
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    if (input.disabled || input.readOnly) return false;
    return !NO_KEYBOARD_INPUT_TYPES.has(input.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * iOS Safari can fire `visualViewport` `resize` only at the END of its keyboard
 * animation, so a focus change also drives a short rAF loop to track through
 * the slide. Same duration, and the same reason, as `MobileInputBar`.
 */
export const KEYBOARD_TRACK_MS = 600;

/** Injected so a test can step the loop instead of waiting on real frames. */
export interface KeyboardClock {
  now(): number;
  raf(fn: () => void): number;
  cancelRaf(handle: number): void;
}

const realClock: KeyboardClock = {
  now: () => performance.now(),
  raf: (fn) => requestAnimationFrame(fn),
  cancelRaf: (h) => cancelAnimationFrame(h),
};

export interface TrackKeyboardInsetDeps {
  /** `window.visualViewport`, or null where it is unsupported — in which case
   *  there is nothing to correct for and the property is never written. */
  viewport: KeyboardViewport | null;
  /** Defaults to `document.activeElement`. */
  activeElement?: () => Element | null;
  clock?: KeyboardClock;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Keep `--chat-keyboard-inset` on `pane` equal to how much of it the software
 * keyboard covers, for as long as the returned disposer has not been called.
 * The property is REMOVED on dispose, so a pane that stops tracking falls back
 * to the stylesheet's `0px` rather than freezing at its last value.
 */
export function trackKeyboardInset(pane: HTMLElement, deps: TrackKeyboardInsetDeps): () => void {
  const { viewport: vv } = deps;
  if (!vv) return () => {};
  const clock = deps.clock ?? realClock;
  const getActive = deps.activeElement ?? (() => document.activeElement);
  const win = deps.win ?? window;
  const doc = deps.doc ?? document;

  // Only write when the value actually changes. `apply` runs from a per-frame
  // loop and from a touch, and an unchanged inline style should not be a style
  // recalculation on either.
  let last: string | null = null;
  const apply = () => {
    const next = `${keyboardInset({
      paneBottom: pane.getBoundingClientRect().bottom,
      vvOffsetTop: vv.offsetTop,
      vvHeight: vv.height,
      editableFocused: raisesSoftKeyboard(getActive()),
    })}px`;
    if (next === last) return;
    last = next;
    pane.style.setProperty('--chat-keyboard-inset', next);
  };

  let frame: number | null = null;
  const trackUntil = (deadline: number) => {
    apply();
    frame = clock.now() < deadline ? clock.raf(() => trackUntil(deadline)) : null;
  };
  // Deliberately NOT synchronous: `focusout` fires BEFORE the incoming element
  // takes focus, so reading `activeElement` in the same turn would see `body`
  // and drop the inset to 0 for a frame even when focus is only moving from one
  // field to another. One frame later it has settled either way.
  const onFocusChange = () => {
    if (frame !== null) clock.cancelRaf(frame);
    const deadline = clock.now() + KEYBOARD_TRACK_MS;
    frame = clock.raf(() => trackUntil(deadline));
  };

  // `apply` reads `getBoundingClientRect`, which forces layout. Off the touch
  // path with it: a `pointerdown` is very often the first millisecond of a
  // scroll, and a synchronous layout flush there is the textbook way to make a
  // fling start late. One frame's delay is invisible for a recovery nobody
  // should be needing in the first place.
  let tapFrame: number | null = null;
  const applyNextFrame = () => {
    if (tapFrame !== null) return;
    tapFrame = clock.raf(() => {
      tapFrame = null;
      apply();
    });
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  pane.addEventListener('focusin', onFocusChange);
  pane.addEventListener('focusout', onFocusChange);
  // The catch-alls. None of these is the normal path; each of them is a way the
  // keyboard has gone away without the normal path saying so.
  pane.addEventListener('pointerdown', applyNextFrame, { passive: true });
  win.addEventListener('resize', apply);
  win.addEventListener('orientationchange', apply);
  win.addEventListener('pageshow', apply);
  doc.addEventListener('visibilitychange', apply);
  apply();

  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    pane.removeEventListener('focusin', onFocusChange);
    pane.removeEventListener('focusout', onFocusChange);
    pane.removeEventListener('pointerdown', applyNextFrame);
    win.removeEventListener('resize', apply);
    win.removeEventListener('orientationchange', apply);
    win.removeEventListener('pageshow', apply);
    doc.removeEventListener('visibilitychange', apply);
    if (frame !== null) clock.cancelRaf(frame);
    if (tapFrame !== null) clock.cancelRaf(tapFrame);
    pane.style.removeProperty('--chat-keyboard-inset');
  };
}
