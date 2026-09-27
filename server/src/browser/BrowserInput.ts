/**
 * What the human did → what CDP needs to hear.
 *
 * The browser runs headless on this machine and is never visible. When somebody
 * takes the wheel they are looking at a JPEG in their muxpad session, possibly
 * on a phone, and their clicks and keystrokes come back here to be replayed into
 * the real page. This module is that translation, and it is pure so it can be
 * tested without a browser.
 *
 * Every mapping below was validated against a real headless Chrome first — a
 * cross-origin iframe payment form, a drag widget that only reports success on a
 * genuine press/move/release with travel, and ordinary typing. The subtleties
 * are marked; each one is a way the relay appears to work and quietly does
 * nothing.
 */

/** CDP's modifier bitmask. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** Modifiers that mean "this is a shortcut", not "this is typing". */
const SHORTCUT_MODS = MOD.ctrl | MOD.meta;

export interface MouseInput {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;
  y: number;
  /** Bitmask of held buttons; 1 is left. */
  buttons?: number;
  clickCount?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
}

export function mouseEvent(input: MouseInput): Record<string, unknown> {
  const buttons = input.buttons ?? 0;
  const pressing = input.type === 'mousePressed' || input.type === 'mouseReleased';

  const event: Record<string, unknown> = {
    type: input.type,
    x: Math.round(input.x),
    y: Math.round(input.y),
    // `buttons` is what makes a move a DRAG. Send moves with buttons: 0 and
    // Chrome synthesises a hover — a drag widget's knob never follows the
    // cursor and the widget silently never completes.
    buttons,
    button: buttons & 1 || pressing ? 'left' : 'none',
    clickCount: input.clickCount ?? (pressing ? 1 : 0),
    modifiers: input.modifiers ?? 0,
  };
  if (input.type === 'mouseWheel') {
    event.deltaX = input.deltaX ?? 0;
    event.deltaY = input.deltaY ?? 0;
  }
  return event;
}

/** Virtual key codes for the named keys that actually come up. */
const VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

function virtualKeyCode(key: string): number {
  if (VK[key] !== undefined) return VK[key] as number;
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

function physicalCode(key: string): string {
  if (key.length !== 1) return key;
  if (/[a-zA-Z]/.test(key)) return `Key${key.toUpperCase()}`;
  if (/[0-9]/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  return '';
}

export interface KeyInput {
  key: string;
  modifiers?: number;
}

/**
 * The keyDown/keyUp pair for one keystroke.
 *
 * THE SUBTLETY: a `dispatchKeyEvent` without `text` produces a keydown the page
 * can observe and NO ACTUAL INPUT. It is the most common way a hand-rolled
 * relay looks like it works and types nothing into the field. So printable
 * characters get `keyDown` with text; everything else gets `rawKeyDown`.
 *
 * A printable character held with ctrl or meta is a SHORTCUT, not typing —
 * cmd-A must select all rather than inserting "a" — so it drops back to
 * rawKeyDown. Shift does not count: shift-A is how you type a capital.
 */
export function keyEvents(input: KeyInput): [Record<string, unknown>, Record<string, unknown>] {
  const { key } = input;
  const modifiers = input.modifiers ?? 0;
  const printable = key.length === 1 && !(modifiers & SHORTCUT_MODS);

  const base = {
    key,
    code: physicalCode(key),
    windowsVirtualKeyCode: virtualKeyCode(key),
    nativeVirtualKeyCode: virtualKeyCode(key),
    modifiers,
  };

  // Enter's text is a carriage return, which is what form handlers listen for.
  const text = key === 'Enter' ? '\r' : printable ? key : undefined;

  const down: Record<string, unknown> = {
    type: text !== undefined ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(text !== undefined ? { text, unmodifiedText: text } : {}),
  };
  return [down, { type: 'keyUp', ...base }];
}

/**
 * Image pixel → page CSS pixel.
 *
 * The viewer may scale the JPEG to fit whatever the human is holding. A tap at
 * image (x,y) has to land on the thing they actually saw.
 *
 * Returns null rather than NaN when the frame has no decoded size yet —
 * `naturalWidth` is 0 for the instant between assigning src and decoding, and a
 * NaN coordinate reaches CDP as a protocol error, so the click is just lost.
 * Null lets the caller drop it deliberately.
 */
export function imageToPageCoords(
  point: { x: number; y: number },
  frame: { naturalWidth: number; deviceWidth: number },
): { x: number; y: number } | null {
  if (!frame.naturalWidth || !frame.deviceWidth) return null;
  const scale = frame.deviceWidth / frame.naturalWidth;
  return { x: Math.round(point.x * scale), y: Math.round(point.y * scale) };
}

/**
 * Whether the page has a text field focused, asked more than once.
 *
 * The viewer raises the phone's keyboard DURING the tap, because iOS honours a
 * focus() only inside a real gesture — so by the time this answer arrives, a
 * keyboard is already up and this decides whether it stays. That makes the two
 * possible mistakes wildly asymmetric:
 *
 *   · a false "yes" leaves a keyboard up over a page that ignores typing —
 *     untidy, and one tap to dismiss;
 *   · a false "no" DISMISSES a keyboard a quarter-second after the person
 *     tapped a login box, which is indistinguishable from the bug where it
 *     never appeared at all.
 *
 * And a false "no" is easy to get: plenty of pages focus their input in a click
 * handler, an effect, or after a layout pass, so the first read lands before
 * `activeElement` has moved. Measured on the real browser the first read is
 * already correct for a plain input — this exists for the ones that are not.
 *
 * So: ask again before believing "no", and never re-ask after a "yes".
 */
export async function probeEditable(
  read: () => Promise<boolean>,
  wait: (ms: number) => Promise<void>,
  retryAfterMs = 150,
): Promise<boolean> {
  if (await read()) return true;
  await wait(retryAfterMs);
  return read();
}
