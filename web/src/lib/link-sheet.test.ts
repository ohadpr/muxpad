import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LinkClick,
  checkFrame,
  linkHost,
  linkRoute,
  markUnframeable,
  resetFrameVerdicts,
  sheetLinkFor,
} from './link-sheet';

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

describe('labels', () => {
  it('names the site, not the whole address', () => {
    expect(linkHost('https://www.nytimes.com/2026/11/13/a.html?x=1')).toBe('nytimes.com');
  });
});

describe('linkRoute — the sheet or the OS browser, decided inside the tap', () => {
  const HTTPS = 'https://example-host.example-tailnet.ts.net';
  beforeEach(resetFrameVerdicts);

  /**
   * ── DESKTOP NEVER GETS THE SHEET ────────────────────────────────────────
   * It exists so a phone does not feel like it left the app. A desktop
   * already has tabs, a back button and two windows side by side; a 1100px
   * iframe over the conversation takes those away to simulate them worse.
   */
  it('opens every link in a new tab on desktop, whatever the site allows', async () => {
    for (const url of ['https://example.com/a', 'http://example-host:4760'])
      expect(linkRoute(url, HTTPS, false), url).toBe('native');
    // Even one the server has confirmed IS framable — seeded through the real
    // path so the verdict cache genuinely holds a yes.
    const yes = vi.fn(async () => Response.json({ frame: true }));
    expect(await checkFrame('https://ok.example/a', HTTPS, yes as unknown as typeof fetch)).toBe(
      true,
    );
    expect(linkRoute('https://ok.example/b', HTTPS, false)).toBe('native');
    // …while the same url on a phone gets the sheet, so it is the LAYOUT
    // deciding here and not the framing check.
    expect(linkRoute('https://ok.example/b', HTTPS, true)).toBe('sheet');
  });

  it('sends an http link on an https muxpad to the OS — mixed content never frames', () => {
    expect(linkRoute('http://example-host:4760', HTTPS, true)).toBe('native');
  });

  it('gives an https link to the sheet, which checks it', () => {
    expect(linkRoute('https://example.com/a', HTTPS, true)).toBe('sheet');
  });

  it('sends a site already found unframeable straight to the OS', () => {
    markUnframeable('https://news.example/one');
    expect(linkRoute('https://news.example/two', HTTPS, true)).toBe('native');
  });

  it('remembers what the server said', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ frame: false, reason: 'x-frame-options DENY' }),
    );
    expect(
      await checkFrame('https://deny.example/a', HTTPS, fetchImpl as unknown as typeof fetch),
    ).toBe(false);
    expect(linkRoute('https://deny.example/b', HTTPS, true)).toBe('native');
    await checkFrame('https://deny.example/c', HTTPS, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('checkFrame', () => {
  const HTTPS = 'https://m.example';
  beforeEach(resetFrameVerdicts);

  it('asks the server, with the page as the parent', async () => {
    const fetchImpl = vi.fn(async (_: RequestInfo | URL) => Response.json({ frame: true }));
    expect(
      await checkFrame('https://ok.example/a?b=1', HTTPS, fetchImpl as unknown as typeof fetch),
    ).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `/api/open/frame?url=${encodeURIComponent('https://ok.example/a?b=1')}&parent=${encodeURIComponent(HTTPS)}`,
    );
  });

  it('treats a server that cannot answer as a no', async () => {
    const old = vi.fn(async () =>
      Response.json({ error: { code: 'not_found', message: 'route not found' } }, { status: 404 }),
    );
    expect(await checkFrame('https://a.example/', HTTPS, old as unknown as typeof fetch)).toBe(
      false,
    );
    const down = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await checkFrame('https://b.example/', HTTPS, down as unknown as typeof fetch)).toBe(
      false,
    );
  });
});
