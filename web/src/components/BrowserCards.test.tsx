import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserCards } from './BrowserCards';

/**
 * The container, and the two things it must get right.
 *
 *   1. OPENING TAKES THE WHEEL FIRST. A viewer that renders input while the
 *      agent still holds the wheel is the two-writers race the wheel exists to
 *      prevent, and it would show up as the agent clicking through the form you
 *      are halfway through.
 *   2. A FAILED POLL LEAVES THE CARDS ALONE. Blanking them on one dropped
 *      request makes a hiccup look like "the browser is gone", which is the
 *      opposite of what a card is for.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hosts: HTMLElement[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
  vi.useRealTimers();
});

const browser = (over: Record<string, unknown> = {}) => ({
  profile: 'shopping',
  viewerUrl: 'https://host.ts.net/browser/shopping/',
  state: 'running',
  wheel: null,
  // A card is drawn from a MOMENT, so a browser with no history draws nothing.
  events: [{ kind: 'opened', at: 100, tabId: 'tab-1' }],
  ...over,
});

/** A fetch that answers GET /api/browsers from `list` and records every call. */
function fakeFetch(list: () => unknown[], opts: { failGet?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET' && opts.failGet) throw new Error('offline');
    if (method === 'GET') return { ok: true, json: async () => ({ browsers: list() }) };
    return { ok: true, json: async () => ({}) };
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { host, rerender: (n: React.ReactNode) => act(async () => root.render(n)) };
}

const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')];
const click = async (el: Element | undefined) =>
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

describe('listing', () => {
  it('draws a card per moment the server reports', async () => {
    const { impl } = fakeFetch(() => [browser(), browser({ profile: 'research' })]);
    const { host } = await mount(
      <BrowserCards by="pane-7" tabId="tab-1" fetchImpl={impl} pollMs={100000} />,
    );
    expect(host.querySelectorAll('[data-testid="browser-card"]')).toHaveLength(2);
    expect(host.textContent).toContain('research');
  });

  it('keeps the last known cards when a poll fails', async () => {
    let fail = false;
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && fail) throw new Error('offline');
      return { ok: true, json: async () => ({ browsers: [browser()] }) };
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    const { host } = await mount(
      <BrowserCards by="pane-7" tabId="tab-1" fetchImpl={impl} pollMs={50} />,
    );
    expect(host.querySelectorAll('[data-testid="browser-card"]')).toHaveLength(1);
    fail = true;
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(host.querySelectorAll('[data-testid="browser-card"]')).toHaveLength(1);
  });
});

describe('what gets a card at all', () => {
  it('draws NOTHING for a browser nothing has happened to', async () => {
    // The old pinned card meant every conversation carried one forever. A card
    // is now a MOMENT, so a browser that merely exists produces none.
    const { impl } = fakeFetch(() => [browser({ events: [] })]);
    const { host } = await mount(
      <BrowserCards by="pane-7" tabId="tab-1" fetchImpl={impl} pollMs={100000} />,
    );
    expect(host.querySelectorAll('[data-testid="browser-card"]')).toHaveLength(0);
  });

  it('draws one card per moment, so opening and getting stuck are separate', async () => {
    const { impl } = fakeFetch(() => [
      browser({
        events: [
          { kind: 'opened', at: 100, tabId: 'tab-1' },
          { kind: 'needs-you', at: 500, reason: 'captcha', tabId: 'tab-1' },
        ],
      }),
    ]);
    const { host } = await mount(
      <BrowserCards by="pane-7" tabId="tab-1" fetchImpl={impl} pollMs={100000} />,
    );
    expect(host.querySelectorAll('[data-testid="browser-card"]')).toHaveLength(2);
  });

  it('draws nothing in a BRAND-NEW chat, whatever happened elsewhere', async () => {
    // The bug this pins: untagged moments used to show everywhere, so opening
    // a new conversation greeted you with cards about things that happened
    // before it existed.
    const { impl } = fakeFetch(() => [
      browser({
        events: [
          { kind: 'opened', at: 100 },
          { kind: 'needs-you', at: 200, reason: 'captcha' },
        ],
      }),
    ]);
    const { host } = await mount(
      <BrowserCards by="pane-7" tabId="brand-new" fetchImpl={impl} pollMs={100000} />,
    );
    expect(host.querySelectorAll('[data-testid="browser-card"]')).toHaveLength(0);
  });

  it('ignores a moment that happened in ANOTHER chat', async () => {
    const { impl } = fakeFetch(() => [
      browser({ events: [{ kind: 'opened', at: 100, tabId: 'somewhere-else' }] }),
    ]);
    const { host } = await mount(
      <BrowserCards by="pane-7" tabId="tab-1" fetchImpl={impl} pollMs={100000} />,
    );
    expect(host.querySelectorAll('[data-testid="browser-card"]')).toHaveLength(0);
  });
});

describe('opening', () => {
  it('does NOT take the wheel when you are only watching', async () => {
    // The session card is for looking over the agent's shoulder. Seizing the
    // browser to do that stalls the task you asked for.
    const { impl, calls } = fakeFetch(() => [browser()]);
    const { host } = await mount(
      <BrowserCards
        by="pane-7"
        tabId="tab-1"
        fetchImpl={impl}
        pollMs={100000}
        viewportWidth={1440}
      />,
    );
    await click(host.querySelector('[data-testid="browser-card"]') ?? undefined);
    expect(calls.find((c) => c.url.includes('/wheel/take'))).toBeUndefined();
  });

  it('TAKES THE WHEEL when you answer a summons', async () => {
    // The agent asked for a person; arriving without it puts you in front of a
    // page you cannot type into.
    const { impl, calls } = fakeFetch(() => [
      browser({
        needsYou: { reason: 'Amazon needs a login', at: 1 },
        events: [{ kind: 'needs-you', at: 100, tabId: 'tab-1', reason: 'Amazon needs a login' }],
      }),
    ]);
    const { host } = await mount(
      <BrowserCards by="pane-7" tabId="tab-1" fetchImpl={impl} pollMs={100000} viewportWidth={1440} />,
    );
    await click(buttons(host)[0]);
    const take = calls.find((c) => c.url.includes('/wheel/take'));
    expect(take?.method).toBe('POST');
    expect(take?.body).toMatchObject({ by: 'pane-7', reason: 'Amazon needs a login' });
  });


  it('opens a modal on a desktop', async () => {
    const { impl } = fakeFetch(() => [browser()]);
    const { host } = await mount(
      <BrowserCards
        by="pane-7"
        tabId="tab-1"
        fetchImpl={impl}
        pollMs={100000}
        viewportWidth={1440}
      />,
    );
    await click(host.querySelector('[data-testid="browser-card"]') ?? undefined);
    expect(document.querySelector('[data-testid="browser-modal"]')).toBeTruthy();
  });

  it('opens a TAB on a phone and never mounts the modal', async () => {
    const openTab = vi.fn();
    const { impl } = fakeFetch(() => [browser()]);
    const { host } = await mount(
      <BrowserCards
        by="pane-7"
        tabId="tab-1"
        fetchImpl={impl}
        pollMs={100000}
        viewportWidth={390}
        openTab={openTab}
      />,
    );
    await click(host.querySelector('[data-testid="browser-card"]') ?? undefined);
    // Watching, so the intent rides the url for the tab too.
    expect(openTab).toHaveBeenCalledWith('https://host.ts.net/browser/shopping/?mode=watch');
    expect(document.querySelector('[data-testid="browser-modal"]')).toBeNull();
  });
});

describe('closing', () => {
  it('hands the wheel straight back instead of letting it lapse', async () => {
    // An agent waiting out a ten-minute timer for a browser nobody is using is
    // the same stall the whole feature is meant to remove.
    const { impl, calls } = fakeFetch(() => [browser()]);
    const { host } = await mount(
      <BrowserCards
        by="pane-7"
        tabId="tab-1"
        fetchImpl={impl}
        pollMs={100000}
        viewportWidth={1440}
      />,
    );
    await click(host.querySelector('[data-testid="browser-card"]') ?? undefined);
    const done = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done');
    await click(done);
    const release = calls.find((c) => c.method === 'DELETE');
    expect(release?.url).toContain('/api/browsers/shopping/wheel');
    expect(release?.body).toMatchObject({ by: 'pane-7' });
    expect(document.querySelector('[data-testid="browser-modal"]')).toBeNull();
  });
});
