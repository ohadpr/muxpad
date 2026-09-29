/** @vitest-environment jsdom */
/// <reference lib="dom" />
import { afterEach, describe, expect, it } from 'vitest';
import {
  deepEditableFocus,
  fieldBoxesExpression,
  focusProbeExpression,
  textFieldBoxes,
} from './FocusProbe.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('finding the focused text field', () => {
  it('sees a plain input', () => {
    document.body.innerHTML = '<input id="t">';
    (document.getElementById('t') as HTMLInputElement).focus();
    expect(deepEditableFocus()).toBe(true);
  });

  it('sees one inside a SHADOW ROOT', () => {
    // activeElement on the document reports the HOST element — a div — so the
    // undescended probe answered "not editable" and the viewer took the phone
    // keyboard away a third of a second after the tap raised it.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input>';
    (root.querySelector('input') as HTMLInputElement).focus();
    expect(document.activeElement?.tagName.toLowerCase()).toBe('div');
    expect(deepEditableFocus()).toBe(true);
  });

  it('says no for a button, wherever it lives', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>go</button>';
    (root.querySelector('button') as HTMLButtonElement).focus();
    expect(deepEditableFocus()).toBe(false);
  });

  it('says no for a checkbox, which is an input that wants no keyboard', () => {
    document.body.innerHTML = '<input id="c" type="checkbox">';
    (document.getElementById('c') as HTMLInputElement).focus();
    expect(deepEditableFocus()).toBe(false);
  });

  it('says yes for a textarea', () => {
    document.body.innerHTML = '<textarea id="a"></textarea>';
    (document.getElementById('a') as HTMLTextAreaElement).focus();
    expect(deepEditableFocus()).toBe(true);
  });

  it('says no when nothing is focused at all', () => {
    document.body.innerHTML = '<p>words</p>';
    (document.activeElement as HTMLElement | null)?.blur();
    expect(deepEditableFocus()).toBe(false);
  });
});

describe('what actually gets shipped into the page', () => {
  it('is the source of the function these tests just exercised', () => {
    // The point of the toString(): a probe tested here and a different probe
    // evaluated in the browser is how this bug survived a green suite once.
    expect(focusProbeExpression()).toContain('shadowRoot');
    expect(focusProbeExpression()).toContain('contentDocument');
    expect(focusProbeExpression()).toMatch(/^\(function deepEditableFocus/);
    expect(focusProbeExpression()).toMatch(/\)\(\)$/);
  });

  it('carries no reference to anything outside itself', () => {
    // It runs in the page, where our module scope does not exist. A closure
    // variable would throw there and be caught as "not editable" — this very
    // bug, arriving by a new door.
    expect(focusProbeExpression()).not.toContain('import');
    expect(focusProbeExpression()).not.toContain('require');
  });
});

describe('finding where the text fields ARE', () => {
  /**
   * The pair has to agree. The focus probe was taught about frames and shadow
   * roots and this was not, so on exactly the pages that fix was for, the viewer
   * was told there were NO fields anywhere — and a tap on the login box raised
   * nothing on its own and waited for the page's answer, which is the round trip
   * the boxes exist to remove.
   */
  /**
   * jsdom has no layout, so every rect is 0x0 and a box with no size is skipped
   * — correctly, since an invisible field is not somewhere to send a keyboard.
   * These give the elements a size so the test measures the RULE rather than
   * jsdom's lack of a renderer.
   */
  const sized = (el: Element, box: Partial<DOMRect> = {}) => {
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 20, ...box }) as DOMRect;
    return el;
  };

  it('finds a plain input', () => {
    document.body.innerHTML = '<input id="t">';
    sized(document.querySelector('input') as Element);
    expect(textFieldBoxes()).toEqual([[0, 0, 100, 20]]);
  });

  it('finds one inside a SHADOW ROOT', () => {
    // The flat version returned NOTHING here, so the viewer believed the page
    // had no fields at all and every tap on the login box was a guess.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input>';
    sized(root.querySelector('input') as Element);
    sized(host);
    expect(textFieldBoxes()).toContainEqual([0, 0, 100, 20]);
  });

  it('skips the inputs that want no keyboard', () => {
    document.body.innerHTML = '<input type="checkbox"><input type="text">';
    for (const el of Array.from(document.querySelectorAll('input'))) sized(el);
    expect(textFieldBoxes()).toHaveLength(1);
  });

  it('skips a field with no size, because that is nowhere to send a keyboard', () => {
    document.body.innerHTML = '<input>';
    sized(document.querySelector('input') as Element, { width: 0, height: 0 });
    expect(textFieldBoxes()).toEqual([]);
  });

  it('offers a frame it CANNOT look into as a candidate', () => {
    // An SSO widget, a payment field, a third-party login. Nothing here or in
    // the focus probe can see whether it holds an input, and reporting nothing
    // meant a tap on such a login box raised no keyboard at all — a dead end,
    // not a blemish. The frame itself becomes the box.
    document.body.innerHTML = '<iframe></iframe>';
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    sized(frame, { left: 20, top: 40, width: 600, height: 120 });
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        throw new Error('cross-origin');
      },
    });
    expect(textFieldBoxes()).toContainEqual([20, 40, 600, 120]);
  });

  it('and one that answers NULL, which is what Chrome actually does', () => {
    // The first version of this fix only caught a THROW, so it missed the very
    // case it was written for: Chrome hands back null for a sandboxed frame.
    // Measured against the real browser — zero boxes reported.
    document.body.innerHTML = '<iframe></iframe>';
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    sized(frame, { left: 5, top: 10, width: 400, height: 90 });
    Object.defineProperty(frame, 'contentDocument', { get: () => null });
    expect(textFieldBoxes()).toContainEqual([5, 10, 400, 90]);
  });

  it('does not offer one it CAN look into and found nothing in', () => {
    // A same-origin frame with no fields is a known quantity: there is nothing
    // to type into, so a keyboard there would be noise with no upside.
    document.body.innerHTML = '<iframe></iframe>';
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    sized(frame, { left: 0, top: 0, width: 300, height: 100 });
    const empty = document.implementation.createHTMLDocument('');
    Object.defineProperty(frame, 'contentDocument', { get: () => empty });
    expect(textFieldBoxes()).toEqual([]);
  });

  it('ships the same text it was tested with, and reaches into both', () => {
    expect(fieldBoxesExpression()).toContain('shadowRoot');
    expect(fieldBoxesExpression()).toContain('contentDocument');
    expect(fieldBoxesExpression()).toMatch(/^\(function textFieldBoxes/);
  });

  it('offsets a frame\u2019s boxes, because the viewer hit-tests in top coordinates', () => {
    // An unoffset inner rect is a keyboard that appears for taps somewhere else.
    expect(fieldBoxesExpression()).toContain('dx + box.left');
    expect(fieldBoxesExpression()).toContain('dy + box.top');
  });

  it('carries no reference to anything outside itself', () => {
    expect(fieldBoxesExpression()).not.toContain('import');
    expect(fieldBoxesExpression()).not.toContain('require');
  });
});
