import { afterEach, describe, expect, it } from 'vitest';
import { type LinkClick, linkHost, linkSheetViewerPath, sheetLinkFor } from './link-sheet';

/**
 * Which clicks open the sheet. The rule is narrow on purpose: a plain click on
 * an outside link in a MESSAGE. Everything else keeps doing what it did.
 */

const ORIGIN = 'http://127.0.0.1:7777';

afterEach(() => {
  document.body.innerHTML = '';
});

function anchor(html: string): Element {
  document.body.innerHTML = html;
  const a = document.querySelector('a');
  if (!a) throw new Error('no anchor');
  return a;
}

const click = (target: Element, over: Partial<LinkClick> = {}): LinkClick => ({
  target,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...over,
});

describe('sheetLinkFor', () => {
  it('takes a plain click on an outside link in a message', () => {
    const a = anchor('<div class="chat-md"><p><a href="https://x.com/post/1">x</a></p></div>');
    expect(sheetLinkFor(click(a), ORIGIN)).toBe('https://x.com/post/1');
  });

  it('takes a click on something INSIDE the link too', () => {
    anchor('<div class="chat-md"><a href="https://example.com/"><code>c</code></a></div>');
    const code = document.querySelector('code') as Element;
    expect(sheetLinkFor(click(code), ORIGIN)).toBe('https://example.com/');
  });

  it('leaves a cmd/ctrl/shift/alt or middle click alone — that is asking for a tab', () => {
    const a = anchor('<div class="chat-md"><a href="https://example.com/">e</a></div>');
    for (const over of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ])
      expect(sheetLinkFor(click(a, over), ORIGIN)).toBeNull();
  });

  it('leaves muxpad’s own links, non-web links and opted-out links alone', () => {
    for (const html of [
      `<div class="chat-md"><a href="${ORIGIN}/api/attachments/a.pdf">same origin</a></div>`,
      '<div class="chat-md"><a href="/browser/default/">relative</a></div>',
      '<div class="chat-md"><a href="mailto:a@b.c">mail</a></div>',
      '<div class="chat-md"><a href="https://e.com/f.zip" download>dl</a></div>',
      '<div class="chat-md" data-native-link><a href="https://e.com/">opted out</a></div>',
    ])
      expect(sheetLinkFor(click(anchor(html)), ORIGIN), html).toBeNull();
  });

  it('only for links in MESSAGE text — not the chat’s own chrome', () => {
    const a = anchor('<div class="chat-pane"><a href="https://example.com/">chrome</a></div>');
    expect(sheetLinkFor(click(a), ORIGIN)).toBeNull();
  });
});

describe('labels and paths', () => {
  it('names the site, not the whole address', () => {
    expect(linkHost('https://www.nytimes.com/2026/11/13/a.html?x=1')).toBe('nytimes.com');
  });

  it('frames the LINKS browser, never a session one', () => {
    expect(linkSheetViewerPath('pane 1')).toBe('/browser/links/?embed=sheet&by=pane%201');
  });
});
