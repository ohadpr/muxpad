import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetFrameVerdicts, sheetLinkFor } from '../lib/link-sheet';
import { Markdown } from './ChatMarkdown';
import { LinkSheet } from './LinkSheet';

/**
 * The in-app link sheet.
 *
 *   1. a link in a message opens it, instead of being handed to the OS;
 *   2. it shows the page in a plain iframe ONLY when the server says it frames,
 *      and otherwise hands the url to the OS browser;
 *   3. there is always a way back: X, Escape, the visible chat behind it, a
 *      drag down;
 *   4. a way out to a real browser stays one tap away;
 *   5. it is a SHEET — part of the screen, from the bottom — not full-screen.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
  resetFrameVerdicts();
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return { host, root };
}

function fakeFetch(open: () => Response = () => Response.json({ frame: true })) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return url.startsWith('/api/open/frame') ? open() : new Response('{}');
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
  it('shows a page that allows framing in a plain iframe of the page itself', async () => {
    const f = fakeFetch();
    const { host } = mount(
      <LinkSheet url="https://example.com/a" onClose={() => {}} fetchImpl={f.impl} />,
    );
    expect(host.querySelector('[data-testid=link-sheet-status]')?.textContent).toContain(
      'example.com',
    );
    await settle();
    expect(f.calls[0]?.url).toBe(
      `/api/open/frame?url=${encodeURIComponent('https://example.com/a')}&parent=${encodeURIComponent(window.location.origin)}`,
    );
    const frame = host.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://example.com/a');
    // Never a muxpad browser viewer.
    expect(frame.getAttribute('src')).not.toMatch(/\/browser\//);
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  });

  it('hands a page that refuses framing to the OS browser, and closes', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const onClose = vi.fn();
    const f = fakeFetch(() => Response.json({ frame: false, reason: 'x-frame-options DENY' }));
    const { host } = mount(
      <LinkSheet url="https://deny.example/a" onClose={onClose} fetchImpl={f.impl} />,
    );
    await settle();
    expect(host.querySelector('iframe')).toBeNull();
    expect(opened).toHaveBeenCalledWith('https://deny.example/a', '_blank');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('when the OS browser is blocked, offers it as one tap instead', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const f = fakeFetch(() =>
      Response.json({ error: { code: 'not_found', message: 'route not found' } }, { status: 404 }),
    );
    const { host } = mount(
      <LinkSheet url="https://old.example/" onClose={() => {}} fetchImpl={f.impl} />,
    );
    await settle();
    const status = host.querySelector('[data-testid=link-sheet-status]') as HTMLElement;
    expect(status.textContent).toContain('can’t be shown here');
    const a = status.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://old.example/');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('gives up on a frame that never loads, and offers the OS browser', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch();
      const { host } = mount(
        <LinkSheet
          url="https://slow.example/"
          onClose={() => {}}
          fetchImpl={f.impl}
          loadTimeoutMs={500}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(host.querySelector('iframe')).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(host.querySelector('iframe')).toBeNull();
      expect(host.querySelector('[data-testid=link-sheet-status] a')?.getAttribute('href')).toBe(
        'https://slow.example/',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a frame that loaded', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch();
      const { host } = mount(
        <LinkSheet
          url="https://fast.example/"
          onClose={() => {}}
          fetchImpl={f.impl}
          loadTimeoutMs={500}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        host.querySelector('iframe')?.dispatchEvent(new Event('load'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(host.querySelector('iframe')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a one-tap way out to a real browser, opted out of the interception', () => {
    const f = fakeFetch();
    const { host } = mount(
      <LinkSheet url="https://example.com/a" onClose={() => {}} fetchImpl={f.impl} />,
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
        <LinkSheet url="https://e.com/" onClose={onClose} fetchImpl={f.impl} />,
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
    const { host } = mount(<LinkSheet url="https://e.com/" onClose={onClose} fetchImpl={f.impl} />);
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

  it('rises from the bottom, which is what the gesture back is anchored to', () => {
    // The HEIGHT assertion that used to live here demanded 60–80dvh. That was
    // the bug, not the contract — see "the panel is full height" below. What
    // survives is the anchoring: the panel is pinned to the bottom edge, which
    // is what makes swiping DOWN the way out.
    const css = readFileSync(join(__dirname, 'LinkSheet.css'), 'utf8');
    const panel = css.slice(css.indexOf('.link-sheet__panel {'));
    const block = panel.slice(0, panel.indexOf('}'));
    expect(block).toMatch(/bottom: 0;/);
  });
});

/**
 * ── THE SHEET FILLS THE SCREEN ────────────────────────────────────────────
 *
 * It was 72%, leaving a strip of conversation above it. That strip showed
 * whatever the chat happened to be scrolled to — almost never the message the
 * link came from — and nothing in it was tappable for anything you would want
 * while reading a page. So it was neither context nor action, just a smaller
 * page: "wtf does it help me to keep 20% of the screen above visible."
 *
 * A CSS assertion because that is where the height lives. The height is the
 * whole complaint, so it is worth a test that fails if someone reinstates a
 * fraction.
 */
describe('the panel is full height', () => {
  const css = readFileSync(join(__dirname, 'LinkSheet.css'), 'utf8');
  const panel = css.slice(css.indexOf('.link-sheet__panel'));
  const rule = panel.slice(0, panel.indexOf('}'));

  it('is 100dvh, not a fraction of the viewport', () => {
    expect(rule).toMatch(/height:\s*100dvh/);
    expect(rule).not.toMatch(/height:\s*\d{1,2}(\.\d+)?d?vh/);
  });

  it('clears the status bar as well as the home indicator', () => {
    // At 72% only the bottom inset mattered. At full height the bar would sit
    // under the notch without the top one.
    expect(rule).toMatch(/padding-top:\s*env\(safe-area-inset-top/);
    expect(rule).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom/);
  });
});
