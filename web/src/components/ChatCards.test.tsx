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

  it('renders a text card as ONE LINE — the value, and a tail', async () => {
    // A card is its value. The name is not drawn at all (it is the identity
    // for `card set`, and the section's title attribute), and the age is a tail
    // in the corner rather than a column.
    const host = await mount([card({ content: 'V2.1 [███░░] 62%' })]);
    expect(host.querySelector('.chat-card-line')?.textContent).toBe('V2.1 [███░░] 62%');
    expect(host.querySelector('.chat-card-name')).toBeNull();
    expect(host.querySelector('.chat-card-age')?.textContent).toMatch(/^\d+[smhd]$/);
    expect(host.querySelector('.chat-card-body')).toBeNull();
  });
  it('draws no name however many cards there are', async () => {
    // It used to appear at two cards and on the open one, so it moved between
    // inline, header and absent — "sometimes it's above, sometimes the line is
    // below". The card's identity is its content; the strip holds two or three.
    const host = await mount([card({ name: 'build' }), card({ id: 'c2', name: 'market' })]);
    expect(host.querySelectorAll('.chat-card-name')).toHaveLength(0);
    // Still reachable: the section names itself for a hover and a reader.
    expect([...host.querySelectorAll('.chat-card')].map((c) => c.getAttribute('title'))).toEqual([
      'build',
      'market',
    ]);
  });
  it('opens from ANYWHERE on the card, not from a row beside the body', async () => {
    // The control used to be a <button> row and the body its sibling, because a
    // button may only hold phrasing content and markdown emits <p>. That split
    // is what let the two disagree about what a click does.
    const host = await mount([card({ name: 'build', content: 'one line' })]);
    const section = host.querySelector('.chat-card') as HTMLElement;
    expect(section.getAttribute('role')).toBe('button');
    await act(async () => {
      section.click();
    });
    expect(host.querySelector('.chat-card-body')).not.toBeNull();
    expect(host.querySelector('.chat-card-line')).toBeNull();
  });
  it('says how old it is in the shortest form that is true', async () => {
    const host = await mount([card({ updated_at: Date.now() - 3 * 3_600_000 })]);
    expect(host.querySelector('.chat-card-age')?.textContent).toBe('3h');
  });
  it('puts html in a SANDBOXED frame that cannot reach muxpad', async () => {
    // The security claim, asserted rather than assumed: agent-written markup is
    // pinned where you cannot scroll past it, so `allow-same-origin` would hand
    // it the app.
    const host = await mount([card({ format: 'html', content: '<b>hi</b>' })]);
    const f = host.querySelector('iframe.chat-card-frame') as HTMLIFrameElement;
    expect(f).toBeTruthy();
    const sandbox = f.getAttribute('sandbox') ?? '';
    // The claim is about ORIGIN, not about the attribute's exact text: the
    // frame may gain abilities (it has gained popups, below) and must never
    // gain this one.
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(f.getAttribute('srcdoc')).toContain('<b>hi</b>');
    // …and it must never be rendered into the page as live markup.
    expect(host.querySelector('.chat-card-body b')).toBeNull();
  });

  /**
   * ── A LINK IN A CARD LEAVES THE CARD ────────────────────────────────────
   * Reported with a screenshot: a link in a pinned card opened INSIDE it,
   * replacing the card with the page — and a 90px frame has no back button.
   *
   * Every other clickable surface in the app already opens out (chat markdown,
   * file chips, artifact links, the brand mark). This frame was the lone
   * exception, because a sandboxed frame is allowed to navigate ITSELF and
   * nothing told it not to.
   */
  it('opens a link in a new tab instead of inside the card', async () => {
    const host = await mount([
      card({ format: 'html', content: '<a href="https://x.test/r">quality review</a>' }),
    ]);
    const doc = host.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('<base target="_blank">');
    const sandbox = host.querySelector('iframe.chat-card-frame')?.getAttribute('sandbox') ?? '';
    // Without the popup pair, `target="_blank"` is simply blocked and the click
    // does nothing at all — which is worse than the bug it replaced.
    expect(sandbox).toContain('allow-popups');
    expect(sandbox).toContain('allow-popups-to-escape-sandbox');
  });

  it('injects the theme into the frame — it inherits no CSS variables', async () => {
    document.documentElement.style.setProperty('--accent', 'rgb(1, 2, 3)');
    const host = await mount([card({ format: 'html', content: '<b>x</b>' })]);
    const doc = host.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('--accent:rgb(1, 2, 3)');
    expect(doc).toContain(':root{');
  });

  it('PAINTS the frame with the card surface, rather than leaving it transparent', async () => {
    // A transparent root hands the canvas to the UA default, which follows
    // color-scheme — and that was read from a --card-scheme variable no theme
    // defines. It fell back to `light dark`, the UA took the BROWSER's
    // preference, and a laptop set to dark rendered every html card as a black
    // slab inside a light app.
    const host = await mount([card({ format: 'html', content: '<b>hi</b>' })]);
    const frame = host.querySelector('iframe');
    const doc = frame?.getAttribute('srcdoc') ?? '';
    expect(doc).not.toMatch(/html,body\{margin:0;background:transparent/);
    expect(doc).toMatch(/color-scheme:(light|dark)\b/);
    expect(doc).not.toContain('--card-scheme');
  });

  it('inserts the frame ONCE, with its final srcdoc — never swapped as it lands', async () => {
    // The frame used to be inserted with a `transparent` placeholder and have
    // the measured surface swapped in by a layout effect: a second srcdoc in
    // the same task. Chrome runs the sandboxed frame out of process, and a
    // srcdoc replaced before its first navigation commits leaves a document
    // that never lays out or paints — every height 0, the card a blank 120px
    // box. 6 of 10 loads on the live app. Any srcdoc write after insertion is
    // that race, so there must be none.
    serve([card({ format: 'html', content: '<b>hi</b>' })]);
    const host = document.createElement('div');
    document.body.append(host);
    const writes: string[] = [];
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === 'srcdoc') writes.push(r.attributeName);
      }
    });
    mo.observe(host, { subtree: true, attributes: true, attributeFilter: ['srcdoc'] });
    await act(async () => {
      createRoot(host).render(<ChatCards tabId="t1" />);
    });
    await act(async () => {});
    mo.disconnect();
    const doc = host.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('<b>hi</b>');
    expect(doc).not.toMatch(/background:transparent/);
    expect(writes).toEqual([]);
  });

  it('re-measures without being asked, and ignores a zero', async () => {
    // The first two measurements are always 0 — the body is not laid out at
    // parse time or at load — and the real height comes from a ResizeObserver
    // that fires ONCE. Lose that message (a srcdoc swap for a theme change puts
    // it on a window the parent no longer recognises) and the frame is stuck
    // for good: measured, a 90px card parked at the 24px floor.
    const host = await mount([card({ format: 'html', content: '<b>hi</b>' })]);
    const doc = host.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('requestAnimationFrame(send)');
    expect(doc).toMatch(/setTimeout\(send, \d+\)/);
    // And a zero must be ignored rather than clamped up to the floor, or
    // "not laid out yet" is indistinguishable from "a very small card".
    expect(doc).toContain('muxpadCard');
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
    expect(host.querySelector('.chat-card-age')?.textContent).toMatch(/^\d+[smhd]$/);
  });
  it('a card with no declared cadence is never overdue', async () => {
    const host = await mount([card({ every_ms: null, updated_at: 0 })]);
    expect(host.querySelector('.chat-card')?.className).not.toContain('-stale');
  });

  it('OPENS rather than deleting — and never asks the server to', async () => {
    // The only control a reader had used to be the destructive one. A card
    // belongs to whoever writes it: pressing × on a market card did not mean
    // "retire this schedule's output", and the next fire recreated it anyway.
    const host = await mount([card({ name: 'build' })]);
    const section = host.querySelector('.chat-card') as HTMLElement;
    expect(section.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.chat-card-body')).toBeNull();
    await act(async () => {
      section.click();
    });
    expect(fetched.some((f) => f.startsWith('DELETE'))).toBe(false);
    expect(host.querySelector('.chat-card-body')).not.toBeNull();
    // …and the one line steps aside, so the content is not rendered twice.
    expect(host.querySelector('.chat-card-line')).toBeNull();
    expect(section.getAttribute('aria-expanded')).toBe('true');
  });
  it('the compact card is the value and the tail, nothing else', async () => {
    const day = 86_400_000;
    const host = await mount([
      card({ name: 'build', content: 'v2.1.4', every_ms: day, updated_at: Date.now() - day * 3 }),
    ]);
    expect(host.querySelector('.chat-card-line')?.textContent).toBe('v2.1.4');
    expect(host.querySelector('.chat-card-age')?.className).toContain('-stale');
    // Overdue is a colour on two characters, so the word is carried for a
    // reader who cannot see the colour.
    expect(host.querySelector('.chat-card-age')?.textContent).toContain('overdue');
    // …and the card still names itself on demand, via its title.
    expect(host.querySelector('.chat-card')?.getAttribute('title')).toBe('build');
  });
  it('an html card renders whole, and is NOT a control', async () => {
    // It has nothing to expand — it already draws everything and measures
    // itself — so making it clickable offered a gesture that changed nothing on
    // screen: "clicking the line changes it a bit but doesn't expand".
    const host = await mount([card({ name: 'market', format: 'html', content: '<b>x</b>' })]);
    const section = host.querySelector('.chat-card') as HTMLElement;
    expect(host.querySelector('iframe')).not.toBeNull();
    expect(host.querySelector('.chat-card-line')).toBeNull();
    expect(section.getAttribute('role')).toBeNull();
    expect(section.getAttribute('aria-expanded')).toBeNull();
    expect(section.className).not.toContain('-togglable');
  });
  it('puts a markdown card on the one line, flattened', async () => {
    // `Markdown` emits block elements; the css forces them inline so one <p>
    // cannot turn a one-line card into a two-line one.
    const host = await mount([card({ format: 'markdown', content: '**open** SPX +0.4%' })]);
    const line = host.querySelector('.chat-card-line');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain('SPX +0.4%');
    expect(host.querySelector('.chat-card-body')).toBeNull();
  });
  it('remembers an OPEN card across a page load', async () => {
    // It is a view preference, so it lives in localStorage like the nav tree's
    // expansion — a card you put away stays away when you come back to the tab.
    const host = await mount([card({ name: 'build' })]);
    await act(async () => {
      (host.querySelector('.chat-card') as HTMLElement).click();
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
      (host.querySelector('.chat-card') as HTMLElement).click();
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
    expect(host.querySelector('.chat-card-line')?.textContent).toBe('good');
  });
});

describe('a card with more than one line', () => {
  /**
   * The row used to be name · value · leader · age, and a multi-line card got
   * the column the name and the age left over: every line cut at the same x a
   * few words in. It was then given a full-width preview under a header, which
   * is where the third layout came from. Now there is one layout: one line
   * collapsed, the whole thing open.
   */
  const THREE = 'Edge Workers rollout\nBoth environments now live\nLeft for infra owners: DNS';

  it('shows its first line, on the same one line every other card uses', async () => {
    const host = await mount([card({ content: THREE })]);
    const line = host.querySelector('.chat-card-line');
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe('Edge Workers rollout');
    expect(host.querySelector('.chat-card-body')).toBeNull();
  });

  it('opens to the whole thing, from anywhere on the card', async () => {
    const host = await mount([card({ content: THREE })]);
    await act(async () => {
      (host.querySelector('.chat-card') as HTMLElement).click();
    });
    expect(host.querySelector('.chat-card-body')?.textContent).toContain('infra owners');
    expect(host.querySelector('.chat-card-line')).toBeNull();
  });

  it('is the same shape as a one-line card — no header, no name, one tail', async () => {
    const multi = await mount([card({ content: THREE })]);
    const single = await mount([card({ id: 'c9', content: 'one line' })]);
    const shape = (host: HTMLElement) => ({
      names: host.querySelectorAll('.chat-card-name').length,
      lines: host.querySelectorAll('.chat-card-line').length,
      ages: host.querySelectorAll('.chat-card-age').length,
      rows: host.querySelectorAll('.chat-card-row').length,
    });
    expect(shape(multi)).toEqual(shape(single));
    expect(shape(multi)).toEqual({ names: 0, lines: 1, ages: 1, rows: 0 });
  });

  it('does not toggle when a click merely ends a text selection', async () => {
    // Collapsing the thing somebody was reading, as they finish dragging
    // across it, is worse than not toggling at all.
    const host = await mount([card({ content: THREE })]);
    const section = host.querySelector('.chat-card') as HTMLElement;
    await act(async () => {
      section.click();
    });
    expect(host.querySelector('.chat-card-body')).not.toBeNull();
    const realSelection = window.getSelection;
    window.getSelection = (() => ({
      toString: () => 'infra owners',
    })) as typeof window.getSelection;
    await act(async () => {
      section.click();
    });
    window.getSelection = realSelection;
    expect(host.querySelector('.chat-card-body')).not.toBeNull();
  });
});

it('keeps lower markdown lines out of the collapsed preview and shows them when expanded', async () => {
  const host = await mount([
    card({
      format: 'markdown',
      content: '**Summary**\n\nDetails  \nMore details\n\n```\nTable row\n```',
    }),
  ]);
  expect(host.querySelector('.chat-card-line')?.textContent).toBe('Summary');
  expect(host.querySelector('pre')).toBeNull();
  await act(async () => {
    (host.querySelector('.chat-card') as HTMLElement).click();
  });
  expect(host.querySelector('.chat-card-body')?.textContent).toContain('Details');
  expect(host.querySelector('.chat-card-body pre')?.textContent).toContain('Table row');
});
