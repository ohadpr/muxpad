import { afterEach, describe, expect, it } from 'vitest';
import {
  KEYBOARD_TRACK_MS,
  type KeyboardViewport,
  keyboardInset,
  raisesSoftKeyboard,
  trackKeyboardInset,
} from './keyboard-inset';

/**
 * The chat composer under a software keyboard, and — the point of this file —
 * AFTER one.
 *
 * ─── The defect, measured ────────────────────────────────────────────────
 * Reported from an installed PWA on an iPhone 14 Pro (393×852): "sometimes the
 * keyboard causes the layout to get stuck like this and it remains this way
 * until I start typing something new." The screenshot shows the composer pill
 * floating 336px — one keyboard — above the bottom of the screen, the
 * conversation ending above it, an empty band below it, and no keyboard.
 *
 * `--chat-keyboard-inset` is a LATCH. The first version of the tracker wrote it
 * from four events (visualViewport resize/scroll, pane focusin/focusout) and
 * from nothing else, so the last observation won forever. Two sequences,
 * measured in Chromium at 393×852 against the real stylesheet (probe in
 * /tmp/muxpad-hunt/kbd-stuck), latched a full keyboard onto a screen with no
 * keyboard on it:
 *
 *   keyboard down; iOS reports the un-pan but not the re-grow    inset 336, want 0
 *   keyboard down; the truth arrives after the 600ms window      inset 336, want 0
 *
 * Both render the screenshot exactly: composer bottom at y=516 of 852, a 336px
 * empty band beneath it. Neither needs a missing event — the first is only
 * iOS's ORDERING, reporting `offsetTop` 336 → 0 while `height` is still the
 * keyboard-up 516.
 *
 * The tests below are written against the two fixes in turn: the invariant
 * ("nothing focused ⇒ no keyboard ⇒ inset 0") and the extra re-assert triggers.
 * Reverting either one turns its tests red — `wire-only` and `unpan-only` fail
 * without the invariant; `resume` and `pointerdown` fail without the triggers.
 */

const H = 852; // iPhone 14 Pro layout viewport in the installed PWA (100lvh)
const KB = 336; // portrait software keyboard, CSS px

// ── doubles ────────────────────────────────────────────────────────────────

interface FakeViewport extends KeyboardViewport {
  emit(type: 'resize' | 'scroll'): void;
  set(next: { height?: number; offsetTop?: number }): void;
}

function makeViewport(height = H, offsetTop = 0): FakeViewport {
  const listeners: Record<'resize' | 'scroll', Set<() => void>> = {
    resize: new Set(),
    scroll: new Set(),
  };
  return {
    height,
    offsetTop,
    addEventListener: (type, fn) => void listeners[type].add(fn),
    removeEventListener: (type, fn) => void listeners[type].delete(fn),
    emit(type) {
      for (const fn of [...listeners[type]]) fn();
    },
    set(next) {
      if (next.height !== undefined) this.height = next.height;
      if (next.offsetTop !== undefined) this.offsetTop = next.offsetTop;
    },
  };
}

/** A hand-cranked rAF, so the 600ms tracking loop is stepped, not waited on. */
function makeClock() {
  let t = 0;
  let nextHandle = 1;
  const queue = new Map<number, () => void>();
  return {
    now: () => t,
    raf: (fn: () => void) => {
      const h = nextHandle++;
      queue.set(h, fn);
      return h;
    },
    cancelRaf: (h: number) => void queue.delete(h),
    /** One animation frame. */
    frame(ms = 16) {
      t += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const fn of due) fn();
    },
    /** Run frames until the loop stops scheduling (i.e. past its deadline). */
    settle() {
      for (let i = 0; i < 200 && queue.size > 0; i++) this.frame();
    },
    pending: () => queue.size,
  };
}

const panes: HTMLElement[] = [];
const disposers: Array<() => void> = [];

/** A `.chat-pane` whose bottom edge is the bottom of the layout viewport. */
function makePane(bottom = H): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-pane';
  el.getBoundingClientRect = () => ({ bottom, top: 0, height: bottom }) as DOMRect;
  document.body.append(el);
  panes.push(el);
  return el;
}

function inset(pane: HTMLElement): string {
  return pane.style.getPropertyValue('--chat-keyboard-inset');
}

afterEach(() => {
  for (const d of disposers.splice(0)) d();
  for (const p of panes.splice(0)) p.remove();
});

/** Wire up a pane + a focused textarea inside it, with everything injectable. */
function mount(opts: { vvHeight?: number; vvOffsetTop?: number } = {}) {
  const pane = makePane();
  const field = document.createElement('textarea');
  pane.append(field);
  const vv = makeViewport(opts.vvHeight ?? H, opts.vvOffsetTop ?? 0);
  const clock = makeClock();
  let focused: Element | null = null;
  const dispose = trackKeyboardInset(pane, {
    viewport: vv,
    clock,
    activeElement: () => focused,
    // jsdom's window/document are real and fine; the tracker subscribes to them
    // for visibilitychange / pageshow / resize.
  });
  disposers.push(dispose);
  return {
    pane,
    field,
    vv,
    clock,
    dispose,
    /** Focus WITHOUT a real keyboard: set activeElement, fire focusin. */
    focus() {
      focused = field;
      pane.dispatchEvent(new Event('focusin', { bubbles: true }));
    },
    blur() {
      focused = null;
      pane.dispatchEvent(new Event('focusout', { bubbles: true }));
    },
    setFocus(el: Element | null) {
      focused = el;
    },
    tap() {
      pane.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    },
    /** The keyboard comes up: viewport shrinks, iOS has not panned. */
    keyboardUp() {
      this.focus();
      vv.set({ height: H - KB, offsetTop: 0 });
      vv.emit('resize');
      clock.settle();
    },
  };
}

// ── the arithmetic ─────────────────────────────────────────────────────────

describe('keyboardInset', () => {
  it('lifts by the keyboard when iOS has not panned the visual viewport', () => {
    expect(keyboardInset({ paneBottom: H, vvOffsetTop: 0, vvHeight: H - KB })).toBe(KB);
  });

  it('lifts by nothing when iOS panned the whole keyboard away itself', () => {
    // offsetTop + height still reaches the pane's bottom: iOS did the work.
    expect(keyboardInset({ paneBottom: H, vvOffsetTop: KB, vvHeight: H - KB })).toBe(0);
  });

  it('never goes negative', () => {
    expect(keyboardInset({ paneBottom: 400, vvOffsetTop: 0, vvHeight: H })).toBe(0);
  });

  it('is 0 when nothing focused could have raised a keyboard, whatever the viewport says', () => {
    // THE BUG. These are the numbers iOS reports mid-dismissal — a shrunken
    // height with the pan already undone. With no field focused they cannot
    // mean a keyboard, and a 336px lift here is the reported screenshot.
    expect(
      keyboardInset({ paneBottom: H, vvOffsetTop: 0, vvHeight: H - KB, editableFocused: false }),
    ).toBe(0);
    expect(
      keyboardInset({ paneBottom: H, vvOffsetTop: 0, vvHeight: H - KB, editableFocused: true }),
    ).toBe(KB);
  });
});

describe('raisesSoftKeyboard', () => {
  const el = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild;
  };

  it('is true for the things that raise one', () => {
    expect(raisesSoftKeyboard(el('<textarea></textarea>'))).toBe(true);
    expect(raisesSoftKeyboard(el('<input>'))).toBe(true);
    expect(raisesSoftKeyboard(el('<input type="search">'))).toBe(true);
    expect(raisesSoftKeyboard(el('<input type="date">'))).toBe(true);
    // iOS raises a picker wheel for a <select>, which shrinks the visual
    // viewport exactly like a keyboard — forcing 0 under it would put the
    // composer back underneath.
    expect(raisesSoftKeyboard(el('<select></select>'))).toBe(true);
  });

  it('is true for a contenteditable', () => {
    const d = document.createElement('div');
    // jsdom does not implement isContentEditable from the attribute.
    Object.defineProperty(d, 'isContentEditable', { value: true });
    expect(raisesSoftKeyboard(d)).toBe(true);
  });

  it('is false for everything that does not', () => {
    expect(raisesSoftKeyboard(null)).toBe(false);
    expect(raisesSoftKeyboard(el('<button>send</button>'))).toBe(false);
    expect(raisesSoftKeyboard(el('<div>a message</div>'))).toBe(false);
    expect(raisesSoftKeyboard(el('<input type="checkbox">'))).toBe(false);
    expect(raisesSoftKeyboard(el('<input type="file">'))).toBe(false);
    expect(raisesSoftKeyboard(el('<input disabled>'))).toBe(false);
    expect(raisesSoftKeyboard(el('<input readonly>'))).toBe(false);
    expect(raisesSoftKeyboard(el('<textarea disabled></textarea>'))).toBe(false);
  });
});

// ── the wiring: the stuck layout, replayed ─────────────────────────────────

describe('trackKeyboardInset holds the composer up, then puts it back', () => {
  it('lifts the composer onto the keyboard', () => {
    const m = mount();
    expect(inset(m.pane)).toBe('0px');
    m.keyboardUp();
    expect(inset(m.pane)).toBe(`${KB}px`);
  });

  it('unpan-only: iOS reports the un-pan and never the re-grow', () => {
    // THE REPORTED BUG, replayed. Keyboard up and panned (inset 0 — iOS did the
    // lift). The user dismisses. iOS undoes the pan first and reports it; the
    // height going back to 852 is coalesced away or simply never announced.
    // `paneBottom - (0 + 516)` = a whole keyboard of lift, latched forever.
    const m = mount();
    m.focus();
    m.vv.set({ height: H - KB, offsetTop: 0 });
    m.vv.emit('resize');
    m.vv.set({ offsetTop: KB });
    m.vv.emit('scroll');
    m.clock.settle();
    expect(inset(m.pane)).toBe('0px'); // iOS panned; nothing for us to do

    m.blur();
    m.vv.set({ offsetTop: 0 }); // the un-pan…
    m.vv.emit('scroll'); // …reported, with height STILL 516
    m.clock.settle();

    expect(inset(m.pane)).toBe('0px');
  });

  it('wire-only: the truth never arrives at all, and the composer still comes down', () => {
    // The second measured sequence: blur fires, every read inside the 600ms
    // window is the stale keyboard-up one, and the correct height lands later
    // with no event attached to it. The invariant does not need the event.
    const m = mount();
    m.keyboardUp();
    expect(inset(m.pane)).toBe(`${KB}px`);

    m.blur(); // viewport still claims 516 — nothing about it has changed yet
    m.clock.settle();

    expect(inset(m.pane)).toBe('0px');
  });

  it('resume: backgrounded with the keyboard up, foregrounded without it', () => {
    // iOS hides the keyboard when the PWA goes away and does not necessarily
    // blur the field or fire a viewport event on the way back. Focus is still
    // in the composer, so the invariant cannot help — the re-assert on page
    // visibility is the only thing that can.
    const m = mount();
    m.keyboardUp();
    expect(inset(m.pane)).toBe(`${KB}px`);

    m.vv.set({ height: H, offsetTop: 0 }); // silently true again
    document.dispatchEvent(new Event('visibilitychange'));

    expect(inset(m.pane)).toBe('0px');
  });

  it('pointerdown: whatever latched it, the next touch clears it', () => {
    // The backstop. No blur, no viewport event, no visibility change — a state
    // nobody predicted. The user's own "it comes back when I do something",
    // made immediate: one touch anywhere in the pane re-measures.
    const m = mount();
    m.keyboardUp();
    m.vv.set({ height: H, offsetTop: 0 });
    expect(inset(m.pane)).toBe(`${KB}px`); // still latched: nothing has fired

    m.tap();
    expect(inset(m.pane)).toBe(`${KB}px`); // NOT in the touch handler — see applyNextFrame
    m.clock.frame();

    expect(inset(m.pane)).toBe('0px');
  });

  it('does not flash the composer down while focus moves between two fields', () => {
    // `focusout` fires BEFORE the incoming element takes focus, so
    // `document.activeElement` in that turn is already `body` and not yet the
    // new field. Applying synchronously there writes 0 for a frame — a visible
    // drop-and-jump with the keyboard still up. The loop starts on the NEXT
    // frame for exactly this reason.
    const m = mount();
    m.keyboardUp();
    const other = document.createElement('input');
    m.pane.append(other);

    m.setFocus(null); // what activeElement really is during focusout
    m.pane.dispatchEvent(new Event('focusout', { bubbles: true }));
    expect(inset(m.pane)).toBe(`${KB}px`); // NOT dropped in the same turn

    m.setFocus(other);
    m.pane.dispatchEvent(new Event('focusin', { bubbles: true }));
    m.clock.settle();

    expect(inset(m.pane)).toBe(`${KB}px`);
  });

  it('tracks through the slide for the whole window and then stops', () => {
    const m = mount();
    m.focus();
    m.clock.frame(); // the deferred first frame
    expect(m.clock.pending()).toBe(1);
    // iOS fires nothing during its animation; the loop is what catches it.
    m.vv.set({ height: H - KB });
    m.clock.frame();
    expect(inset(m.pane)).toBe(`${KB}px`);
    m.clock.frame(KEYBOARD_TRACK_MS);
    m.clock.settle();
    expect(m.clock.pending()).toBe(0);
  });

  it('hands the pane back to the stylesheet on dispose', () => {
    // A pane that stops tracking must not freeze at its last value.
    const m = mount();
    m.keyboardUp();
    expect(inset(m.pane)).toBe(`${KB}px`);
    m.dispose();
    expect(inset(m.pane)).toBe('');
  });

  it('writes nothing at all where visualViewport is unsupported', () => {
    const pane = makePane();
    const dispose = trackKeyboardInset(pane, { viewport: null });
    expect(pane.style.getPropertyValue('--chat-keyboard-inset')).toBe('');
    dispose();
  });
});
