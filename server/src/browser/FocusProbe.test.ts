/** @vitest-environment jsdom */
/// <reference lib="dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { deepEditableFocus, focusProbeExpression } from './FocusProbe.js';

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
