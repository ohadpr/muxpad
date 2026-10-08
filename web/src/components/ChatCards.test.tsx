import type { ChatCard } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Set<(e: unknown) => void>();
vi.mock('../events', () => ({
  subscribe: (h: (e: unknown) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  subscribeResync: () => () => {},
}));

import { __reloadCardCollapse } from '../lib/card-collapse';
import { ChatCards } from './ChatCards';

/**
 * The pinned cards. What is worth holding:
 *
 *   1. an html card is SANDBOXED and cannot reach muxpad — it is agent-written
 *      markup pinned where you cannot scroll past it;
 *   2. the event is a nudge, not a payload: a `cards.updated` for THIS chat
 *      re-fetches, and one for another chat is ignored;
 *   3. a card that stopped being written says so, because that is the failure
 *      nobody would otherwise notice.
 */
const card = (over: Partial<ChatCard> = {}): ChatCard => ({
  id: `c-${over.name ?? 'build'}`,
  tab_id: 't1',
  name: 'build',
  content: '62%',
  format: 'text',
  every_ms: null,
  created_at: 1000,
  updated_at: Date.now(),
  ...over,
});

let fetched: string[] = [];
function serve(cards: ChatCard[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetched.push(`${init?.method ?? 'GET'} ${url}`);
      return { ok: true, json: async () => ({ cards }) } as Response;
    }),
  );
}

async function mount(cards: ChatCard[], tabId: string | null = 't1') {
  serve(cards);
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(<ChatCards tabId={tabId} />);
  });
  return host;
}

beforeEach(() => {
  fetched = [];
  handlers.clear();
  localStorage.clear();
  __reloadCardCollapse();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('pinned chat cards', () => {
  it('renders nothing when a chat has none', async () => {
    const host = await mount([]);
    expect(host.querySelector('.chat-cards')).toBeNull();
  });

  it('renders a text card verbatim', async () => {
    const host = await mount([card({ content: 'V2.1 [███░░] 62%' })]);
    expect(host.querySelector('.chat-card-name')?.textContent).toBe('build');
    expect(host.querySelector('.chat-card-text')?.textContent).toBe('V2.1 [███░░] 62%');
  });

  it('puts html in a SANDBOXED frame that cannot reach muxpad', async () => {
    // The security claim, asserted rather than assumed: agent-written markup is
    // pinned where you cannot scroll past it, so `allow-same-origin` would hand
    // it the app.
    const host = await mount([card({ format: 'html', content: '<b>hi</b>' })]);
    const f = host.querySelector('iframe.chat-card-frame') as HTMLIFrameElement;
    expect(f).toBeTruthy();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('srcdoc')).toContain('<b>hi</b>');
    // …and it must never be rendered into the page as live markup.
    expect(host.querySelector('.chat-card-body b')).toBeNull();
  });

  it('injects the theme into the frame — it inherits no CSS variables', async () => {
    document.documentElement.style.setProperty('--accent', 'rgb(1, 2, 3)');
    const host = await mount([card({ format: 'html', content: '<b>x</b>' })]);
    const doc = host.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('--accent:rgb(1, 2, 3)');
    expect(doc).toContain(':root{');
  });

  it('gives the frame a way to report its own height', async () => {
    // The parent cannot measure a sandboxed frame (contentDocument is null), so
    // without this the card renders at the iframe default with content cut off.
    const host = await mount([card({ format: 'html', content: '<b>x</b>' })]);
    expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('postMessage');
  });

  it('re-fetches on an event for THIS chat', async () => {
    await mount([card()]);
    const before = fetched.length;
    await act(async () => {
      for (const h of handlers) h({ type: 'cards.updated', tab_id: 't1' });
    });
    expect(fetched.length).toBe(before + 1);
  });

  it('ignores an event for another chat', async () => {
    await mount([card()]);
    const before = fetched.length;
    await act(async () => {
      for (const h of handlers) h({ type: 'cards.updated', tab_id: 'somewhere-else' });
    });
    expect(fetched.length).toBe(before);
  });

  it('marks a card overdue when its writer stopped', async () => {
    const day = 86_400_000;
    const host = await mount([card({ every_ms: day, updated_at: Date.now() - day * 3 })]);
    const age = host.querySelector('.chat-card-age');
    expect(age?.className).toContain('-stale');
    expect(age?.textContent).toContain('overdue');
  });

  it('does not nag a card that is merely a little late', async () => {
    const day = 86_400_000;
    const host = await mount([card({ every_ms: day, updated_at: Date.now() - day - 60_000 })]);
    expect(host.querySelector('.chat-card-age')?.className).not.toContain('-stale');
  });

  it('a card with no declared cadence is never overdue', async () => {
    const host = await mount([card({ every_ms: null, updated_at: 0 })]);
    expect(host.querySelector('.chat-card-age')?.className).not.toContain('-stale');
  });

  it('COLLAPSES rather than deleting — and never asks the server to', async () => {
    // The only control a reader had used to be the destructive one. A card
    // belongs to whoever writes it: pressing × on a market card did not mean
    // "retire this schedule's output", and the next fire recreated it anyway —
    // a button that appeared to work and then undid itself.
    const host = await mount([card({ name: 'build' })]);
    const head = host.querySelector('.chat-card-head') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      head.click();
    });
    expect(fetched.some((f) => f.startsWith('DELETE'))).toBe(false);
    // The card stays — it is the BODY that goes.
    expect(host.querySelector('.chat-card')).not.toBeNull();
    expect(host.querySelector('.chat-card-body')).toBeNull();
    expect(host.querySelector('.chat-card-head')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps saying what it is while collapsed', async () => {
    // A collapsed card that showed only a chevron would be a card you cannot
    // find again. The header still carries the name, the age, and the thing
    // worth interrupting you for: that the writer stopped.
    const day = 86_400_000;
    const host = await mount([
      card({ name: 'build', every_ms: day, updated_at: Date.now() - day * 3 }),
    ]);
    await act(async () => {
      (host.querySelector('.chat-card-head') as HTMLButtonElement).click();
    });
    expect(host.querySelector('.chat-card-name')?.textContent).toBe('build');
    expect(host.querySelector('.chat-card-age')?.className).toContain('-stale');
  });

  it('unmounts a collapsed html card\u2019s frame', async () => {
    // Not merely hidden: the frame re-measures itself and posts its height, so
    // one left mounted behind display:none keeps reporting for something nobody
    // can see.
    const host = await mount([card({ name: 'market', format: 'html', content: '<b>x</b>' })]);
    expect(host.querySelector('iframe')).not.toBeNull();
    await act(async () => {
      (host.querySelector('.chat-card-head') as HTMLButtonElement).click();
    });
    expect(host.querySelector('iframe')).toBeNull();
  });

  it('remembers the collapse across a remount', async () => {
    // It is a view preference, so it lives in localStorage like the nav tree's
    // expansion — a card you put away stays away when you come back to the tab.
    const host = await mount([card({ name: 'build' })]);
    await act(async () => {
      (host.querySelector('.chat-card-head') as HTMLButtonElement).click();
    });
    document.body.innerHTML = '';
    // Drop the module's memory and re-read storage — a page load, not a
    // remount. Without this the test would pass on the in-memory copy alone.
    __reloadCardCollapse();
    const again = await mount([card({ name: 'build' })]);
    expect(again.querySelector('.chat-card-body')).toBeNull();
  });

  it('collapses by NAME, so a rewritten card stays put away', async () => {
    // `TabCardStore.set` upserts on (tab_id, name); a clear-and-recreate mints
    // a new row id. Keyed on the id, that would silently re-expand a card the
    // reader had deliberately collapsed.
    const host = await mount([card({ name: 'build' })]);
    await act(async () => {
      (host.querySelector('.chat-card-head') as HTMLButtonElement).click();
    });
    document.body.innerHTML = '';
    __reloadCardCollapse();
    const again = await mount([card({ id: 'a-brand-new-row', name: 'build' })]);
    expect(again.querySelector('.chat-card-body')).toBeNull();
  });

  it('asks for nothing when the pane has no chat yet', async () => {
    await mount([], null);
    expect(fetched).toEqual([]);
  });

  it('keeps what is on screen when a refresh fails', async () => {
    const host = await mount([card({ content: 'good' })]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await act(async () => {
      for (const h of handlers) h({ type: 'cards.updated', tab_id: 't1' });
    });
    // A card blanking because of one dropped request is a worse lie than a
    // card a few seconds stale.
    expect(host.querySelector('.chat-card-text')?.textContent).toBe('good');
  });
});
