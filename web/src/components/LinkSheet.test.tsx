import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sheetLinkFor } from '../lib/link-sheet';
import { Markdown } from './ChatMarkdown';
import { LinkSheet } from './LinkSheet';

/**
 * The in-app link sheet.
 *
 *   1. a link in a message opens it, instead of being handed to the OS;
 *   2. it opens the LINKS browser and takes that wheel — never the chat's own;
 *   3. there is always a way back: X, Escape, the visible chat behind it, a
 *      drag down — and the wheel is handed back when it closes;
 *   4. a way out to a real browser stays one tap away;
 *   5. it is a SHEET — part of the screen, from the bottom — not full-screen.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return { host, root };
}

function fakeFetch(open: () => Response = () => new Response('{}')) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return url.endsWith('/open') ? open() : new Response('{}');
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

const settle = () => act(async () => {});

describe('a link in a message', () => {
  it('opens the sheet instead of leaving muxpad', () => {
    const opened: string[] = [];
    const { host } = mount(
      <div
        onClickCapture={(e) => {
          const url = sheetLinkFor(e, window.location.origin);
          if (url) {
            e.preventDefault();
            opened.push(url);
          }
        }}
      >
        <Markdown text="read [this](https://example.com/story) please" />
      </div>,
    );
    const a = host.querySelector('a') as HTMLAnchorElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      a.dispatchEvent(ev);
    });
    expect(opened).toEqual(['https://example.com/story']);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('LinkSheet', () => {
  it('opens the link in the LINKS browser, as this pane, then shows that viewer', async () => {
    const f = fakeFetch();
    const { host } = mount(
      <LinkSheet url="https://example.com/a" by="pane-7" onClose={() => {}} fetchImpl={f.impl} />,
    );
    expect(host.querySelector('[data-testid=link-sheet-status]')?.textContent).toContain(
      'example.com',
    );
    await settle();
    expect(f.calls[0]).toEqual({
      url: '/api/browsers/links/open',
      method: 'POST',
      body: { url: 'https://example.com/a', by: 'pane-7' },
    });
    const frame = host.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('/browser/links/?embed=sheet&by=pane-7');
  });

  it('says why when it cannot, and offers the real browser instead', async () => {
    const f = fakeFetch(() =>
      Response.json({ error: 'no browser muxpad can own' }, { status: 503 }),
    );
    const { host } = mount(
      <LinkSheet url="https://example.com/a" by="p" onClose={() => {}} fetchImpl={f.impl} />,
    );
    await settle();
    expect(host.querySelector('iframe')).toBeNull();
    const status = host.querySelector('[data-testid=link-sheet-status]') as HTMLElement;
    expect(status.textContent).toContain('no browser muxpad can own');
    expect(status.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
  });

  it('keeps a one-tap way out to a real browser, opted out of the interception', () => {
    const f = fakeFetch();
    const { host } = mount(
      <LinkSheet url="https://example.com/a" by="p" onClose={() => {}} fetchImpl={f.impl} />,
    );
    const out = host.querySelector('.link-sheet__out') as HTMLAnchorElement;
    expect(out.getAttribute('href')).toBe('https://example.com/a');
    expect(out.getAttribute('target')).toBe('_blank');
    expect(out.hasAttribute('data-native-link')).toBe(true);
  });

  it('closes from the X, from Escape, and from the chat showing behind it', () => {
    for (const how of ['x', 'escape', 'scrim'] as const) {
      const onClose = vi.fn();
      const f = fakeFetch();
      const { host } = mount(
        <LinkSheet url="https://e.com/" by="p" onClose={onClose} fetchImpl={f.impl} />,
      );
      act(() => {
        if (how === 'x') (host.querySelector('[aria-label=Close]') as HTMLElement).click();
        if (how === 'scrim')
          (host.querySelector('[data-testid=link-sheet-scrim]') as HTMLElement).click();
        if (how === 'escape')
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onClose, how).toHaveBeenCalledTimes(1);
      act(() => roots.pop()?.unmount());
    }
  });

  it('closes on a drag down the bar, and not on a nudge', () => {
    const onClose = vi.fn();
    const f = fakeFetch();
    const { host } = mount(
      <LinkSheet url="https://e.com/" by="p" onClose={onClose} fetchImpl={f.impl} />,
    );
    const bar = host.querySelector('[data-testid=link-sheet-bar]') as HTMLElement;
    const drag = (dy: number) =>
      act(() => {
        bar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }));
        bar.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 100 + dy }));
        bar.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 100 + dy }));
      });
    drag(20);
    expect(onClose).not.toHaveBeenCalled();
    drag(160);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hands the wheel back when it closes, and renews it while open', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch();
      mount(
        <LinkSheet
          url="https://e.com/"
          by="pane-7"
          onClose={() => {}}
          fetchImpl={f.impl}
          renewMs={1000}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(f.calls.some((c) => c.url === '/api/browsers/links/wheel/renew')).toBe(true);
      act(() => roots.pop()?.unmount());
      expect(f.calls.at(-1)).toEqual({
        url: '/api/browsers/links/wheel',
        method: 'DELETE',
        body: { by: 'pane-7' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is ONE bar: no Back until there is somewhere to go back to, then Back drives the page', async () => {
    const f = fakeFetch();
    const { host } = mount(
      <LinkSheet url="https://a.example/1" by="p" onClose={() => {}} fetchImpl={f.impl} />,
    );
    await settle();
    const frame = host.querySelector('iframe') as HTMLIFrameElement;
    const win = frame.contentWindow as Window;
    const posted: unknown[] = [];
    vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => {
      posted.push(m);
    });
    const hear = (url: string, source: Window | null = win) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { muxpad: 'url', url },
            origin: window.location.origin,
            source,
          }),
        );
      });
    const back = () => host.querySelector<HTMLButtonElement>('[aria-label=Back]');
    const site = () => host.querySelector('.link-sheet__host')?.textContent;

    hear('https://a.example/1');
    expect(back()).toBeNull();
    // A page that is not this frame does not get to rename the site.
    hear('https://evil.example/', null);
    expect(site()).toBe('a.example');
    hear('https://b.example/2');
    // The bar names the site you are ON, and the way out goes there too.
    expect(site()).toBe('b.example');
    expect(host.querySelector('.link-sheet__out')?.getAttribute('href')).toBe(
      'https://b.example/2',
    );
    act(() => back()?.click());
    expect(posted).toEqual([{ muxpad: 'back' }]);
    hear('https://a.example/1');
    expect(back()).toBeNull();
  });

  it('is a SHEET from the bottom, not the full-screen shape it replaces', () => {
    const css = readFileSync(join(__dirname, 'LinkSheet.css'), 'utf8');
    const panel = css.slice(css.indexOf('.link-sheet__panel {'));
    const block = panel.slice(0, panel.indexOf('}'));
    expect(block).toMatch(/bottom: 0;/);
    const h = Number(/height: (\d+)dvh;/.exec(block)?.[1]);
    expect(h).toBeGreaterThanOrEqual(60);
    expect(h).toBeLessThanOrEqual(80);
  });
});
