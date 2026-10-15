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

import { __reloadCardOpen } from '../lib/card-open';
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
  __reloadCardOpen();
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

  it('renders a text card as ONE ROW — value only, no header, no name', async () => {
    // 44% of a one-line card used to be a header saying its name and its age.
    // Both are gone from the row: the header entirely, and the name whenever
    // there is nothing to tell this card apart from.
    const host = await mount([card({ content: 'V2.1 [███░░] 62%' })]);
    expect(host.querySelector('.chat-card-value')?.textContent).toBe('V2.1 [███░░] 62%');
    expect(host.querySelector('.chat-card-name')).toBeNull();
    // No separate body until somebody opens it.
    expect(host.querySelector('.chat-card-body')).toBeNull();
  });

  it('brings the name BACK as soon as there are two cards', async () => {
    // With one card the name labels the only thing in the strip, and on a 430px
    // phone costs the tail of the value. With two it is the only thing saying
    // which row is which.
    const host = await mount([card({ name: 'build' }), card({ id: 'c2', name: 'market' })]);
    const names = [...host.querySelectorAll('.chat-card-name')].map((e) => e.textContent);
    expect(names).toEqual(['build', 'market']);
  });

  it('shows the name on the one card you OPEN', async () => {
    // Never lost, only deferred: inspecting a card is exactly when you want to
    // know which one it is.
    const host = await mount([card({ name: 'build' })]);
    expect(host.querySelector('.chat-card-name')).toBeNull();
    await act(async () => {
      (host.querySelector('.chat-card-row') as HTMLButtonElement).click();
    });
    expect(host.querySelector('.chat-card-name')?.textContent).toBe('build');
  });

  it('drives the rail from FRESHNESS, not just from staleness', async () => {
    // The row carries no timestamp any more, so the rail is the readout: a
    // number on the element, interpolated by the stylesheet, rather than three
    // named buckets. Half a cadence old is half fresh.
    const day = 86_400_000;
    const host = await mount([card({ every_ms: day, updated_at: Date.now() - day / 2 })]);
    const fresh = (host.querySelector('.chat-card') as HTMLElement).style.getPropertyValue(
      '--card-fresh',
    );
    expect(Number(fresh)).toBeGreaterThan(0.4);
    expect(Number(fresh)).toBeLessThan(0.6);
    // And the leader is a real element, not a pseudo — the only thing left
    // saying how current a card is must be something a test can look at.
    expect(host.querySelector('.chat-card-leader')).not.toBeNull();
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

  it('marks a card overdue when its writer stopped — on the row AND the rail', async () => {
    const day = 86_400_000;
    const host = await mount([card({ every_ms: day, updated_at: Date.now() - day * 3 })]);
    const age = host.querySelector('.chat-card-age');
    expect(age?.className).toContain('-stale');
    expect(age?.textContent).toContain('overdue');
    // The rail carries it too, so a stalled card is visible from the corner of
    // your eye without reading a word. The css colours `.chat-card.-stale`.
    expect(host.querySelector('.chat-card')?.className).toContain('-stale');
  });

  it('always shows the age, pinned to the right edge', async () => {
    // Suppressed until overdue once, on the argument that the rail carries
    // freshness as colour. A colour ramp says something is getting old; it does
    // not say it is four hours old, which is a number you read off a market
    // card. Asked for back explicitly.
    const day = 86_400_000;
    const host = await mount([card({ every_ms: day, updated_at: Date.now() - day - 60_000 })]);
    const age = host.querySelector('.chat-card-age');
    expect(age).not.toBeNull();
    // Not overdue — it is merely a minute past cadence — so no warning.
    expect(age?.className).not.toContain('-stale');
    expect(host.querySelector('.chat-card')?.className).not.toContain('-stale');
  });

  it('shows it on a card with no declared cadence too', async () => {
    const host = await mount([card({ every_ms: null })]);
    expect(host.querySelector('.chat-card-age')?.textContent).toMatch(/ago$/);
  });

  it('a card with no declared cadence is never overdue', async () => {
    const host = await mount([card({ every_ms: null, updated_at: 0 })]);
    expect(host.querySelector('.chat-card')?.className).not.toContain('-stale');
  });

  it('OPENS rather than deleting — and never asks the server to', async () => {
    // The only control a reader had used to be the destructive one. A card
    // belongs to whoever writes it: pressing × on a market card did not mean
    // "retire this schedule's output", and the next fire recreated it anyway —
    // a button that appeared to work and then undid itself.
    const host = await mount([card({ name: 'build' })]);
    const row = host.querySelector('.chat-card-row') as HTMLButtonElement;
    // Compact is the DEFAULT now: the value rides in the row, there is no body.
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.chat-card-body')).toBeNull();
    await act(async () => {
      row.click();
    });
    expect(fetched.some((f) => f.startsWith('DELETE'))).toBe(false);
    expect(host.querySelector('.chat-card-body')).not.toBeNull();
    // …and the one-line value steps aside, so the content is not rendered twice.
    expect(host.querySelector('.chat-card-value')).toBeNull();
    expect(host.querySelector('.chat-card-row')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('the compact row still says everything that matters', async () => {
    // Name, value, and the one thing worth interrupting you for. A row that
    // showed only a value would be a card you cannot identify.
    const day = 86_400_000;
    const host = await mount([
      card({ name: 'build', content: 'v2.1.4', every_ms: day, updated_at: Date.now() - day * 3 }),
    ]);
    expect(host.querySelector('.chat-card-value')?.textContent).toBe('v2.1.4');
    expect(host.querySelector('.chat-card-age')?.className).toContain('-stale');
    // …and the row still names itself on demand, via its title.
    expect(host.querySelector('.chat-card-row')?.getAttribute('title')).toContain('build');
  });

  it('an html card keeps its body — there is no one line of a frame', async () => {
    // Text and markdown ride in the row; a sandboxed iframe has no single line
    // to put there, so it is the one format that still costs two rows.
    const host = await mount([card({ name: 'market', format: 'html', content: '<b>x</b>' })]);
    expect(host.querySelector('iframe')).not.toBeNull();
    expect(host.querySelector('.chat-card-value')).toBeNull();
    expect(host.querySelector('.chat-card-row')?.getAttribute('title')).toContain('market');
  });

  it('lays a markdown card out INLINE, in the row', async () => {
    // `Markdown` emits block elements; the css forces them inline so one <p>
    // cannot break the row. Asserted here because the alternative — a card
    // silently two rows tall — is the exact thing this layout exists to stop.
    const host = await mount([card({ format: 'markdown', content: '**open** SPX +0.4%' })]);
    const value = host.querySelector('.chat-card-value');
    expect(value).not.toBeNull();
    expect(value?.textContent).toContain('SPX +0.4%');
    expect(host.querySelector('.chat-card-body')).toBeNull();
  });

  it('remembers an OPEN card across a page load', async () => {
    // It is a view preference, so it lives in localStorage like the nav tree's
    // expansion — a card you put away stays away when you come back to the tab.
    const host = await mount([card({ name: 'build' })]);
    await act(async () => {
      (host.querySelector('.chat-card-row') as HTMLButtonElement).click();
    });
    document.body.innerHTML = '';
    // Drop the module's memory and re-read storage — a page load, not a
    // remount. Without this the test would pass on the in-memory copy alone.
    __reloadCardOpen();
    const again = await mount([card({ name: 'build' })]);
    expect(again.querySelector('.chat-card-body')).not.toBeNull();
  });

  it('keys on the NAME, so a rewritten card stays open', async () => {
    // `TabCardStore.set` upserts on (tab_id, name); a clear-and-recreate mints
    // a new row id. Keyed on the id, that would silently re-expand a card the
    // reader had deliberately collapsed.
    const host = await mount([card({ name: 'build' })]);
    await act(async () => {
      (host.querySelector('.chat-card-row') as HTMLButtonElement).click();
    });
    document.body.innerHTML = '';
    __reloadCardOpen();
    const again = await mount([card({ id: 'a-brand-new-row', name: 'build' })]);
    expect(again.querySelector('.chat-card-body')).not.toBeNull();
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
    expect(host.querySelector('.chat-card-value')?.textContent).toBe('good');
  });
});

describe('a card with more than one line', () => {
  /**
   * The row is name · value · leader · age, and for a one-line card that is
   * exactly right. Give it three lines and the columns become a vice: every
   * line is cut at the same x a few words in, because the value gets whatever
   * the name and the age left behind. Reported from a phone as cards "split
   * into free columns which severely limits how much content can fit".
   */
  const THREE = 'Edge Workers rollout\nBoth environments now live\nLeft for infra owners: DNS';

  it('puts its content on its own line instead of in the leftover column', async () => {
    const host = await mount([card({ content: THREE })]);
    expect(host.querySelector('.chat-card-preview')?.textContent).toContain('infra owners');
    // NOT in the row's value slot, which is the narrow column.
    expect(host.querySelector('.chat-card-value')).toBeNull();
  });

  it('keeps the header — the name, the age and the drifting leader', async () => {
    const host = await mount([card({ content: THREE }), card({ name: 'other', content: 'x' })]);
    const row = host.querySelector('.chat-card-row');
    expect(row?.querySelector('.chat-card-name')?.textContent).toBe('build');
    expect(row?.querySelector('.chat-card-age')).not.toBeNull();
    // The leader is what pushes the age to the far edge AND says the card is
    // live; a stacked card must not quietly lose either.
    expect(row?.querySelector('.chat-card-leader')).not.toBeNull();
  });

  it('is still ONE control — the whole thing opens the card', async () => {
    const host = await mount([card({ content: THREE })]);
    const row = host.querySelector('.chat-card-row');
    expect(row?.tagName).toBe('BUTTON');
    expect(row?.querySelector('.chat-card-preview')).not.toBeNull();
  });

  it('leaves a one-line card exactly as it was', async () => {
    const host = await mount([card({ content: 'V2.1 [###--] 62%' })]);
    expect(host.querySelector('.chat-card-value')?.textContent).toBe('V2.1 [###--] 62%');
    expect(host.querySelector('.chat-card-preview')).toBeNull();
  });

  it('shows the whole thing once it is OPEN, not the bounded preview', async () => {
    const host = await mount([card({ content: THREE })]);
    const row = host.querySelector('.chat-card-row') as HTMLButtonElement;
    await act(async () => {
      row.click();
    });
    expect(host.querySelector('.chat-card-preview')).toBeNull();
    expect(host.querySelector('.chat-card-body')?.textContent).toContain('infra owners');
  });
});

describe('the tape', () => {
  it('runs a leader from the value to the age', async () => {
    const host = await mount([card({ content: 'V2.1 62%' })]);
    const row = host.querySelector('.chat-card-row');
    const kids = [...(row?.children ?? [])].map((e) => e.className);
    // Order matters: value, then the dots, then the age. A leader after the age
    // is just a decoration trailing off the end of the row.
    expect(kids).toEqual(['chat-card-value', 'chat-card-leader', 'chat-card-age']);
  });

  it('drops the leader when the card is OPEN', async () => {
    // Opened, the value moves to its own block below and the row is just a name
    // and an age — there is no gap for a leader to lead across.
    const host = await mount([card()]);
    await act(async () => {
      (host.querySelector('.chat-card-row') as HTMLButtonElement).click();
    });
    expect(host.querySelector('.chat-card-leader')).toBeNull();
  });

  it('has no leader on an html card either', async () => {
    // Same reason: an iframe has no one-line value, so the row never had a gap.
    const host = await mount([card({ format: 'html', content: '<b>x</b>' })]);
    expect(host.querySelector('.chat-card-leader')).toBeNull();
  });
});
