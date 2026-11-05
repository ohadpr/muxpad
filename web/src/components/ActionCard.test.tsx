import type { ChatAction } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { injectActionCards } from '../lib/chat-actions';
import { ActionCard } from './ActionCard';

/**
 * THE CARD, and the two things it must not get wrong: what it SAYS about an
 * outcome, and WHERE it lands in a partially-loaded log.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const action = (over: Partial<ChatAction> = {}): ChatAction => ({
  id: 'a1',
  pane_id: 'p1',
  at: 1_000,
  kind: 'slack.post',
  title: 'Posted to #general',
  body: 'the build is green',
  state: 'sent',
  ...over,
});

const mount = (a: ChatAction) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<ActionCard action={a} />));
  return host as HTMLDivElement;
};

describe('what it says', () => {
  it('names the act and how it ended, in words', () => {
    const box = mount(action());
    expect(box.textContent).toContain('Posted to #general');
    // A WORD, not a colour alone: colour says nothing in greyscale or to a
    // colourblind reader, and this card exists to be unambiguous.
    expect(box.textContent).toContain('sent');
  });

  it('says WAITING rather than showing a spinner', () => {
    // Every outbound integration goes through an approval, so this is a real
    // and usually long-lived state — not a load.
    expect(mount(action({ state: 'pending' })).textContent).toContain('waiting for you');
  });

  it('keeps a decline apart from a failure', () => {
    const declined = mount(action({ state: 'declined' }));
    expect(declined.textContent).toContain('declined');
    expect(declined.querySelector('.action-card')?.getAttribute('data-state')).toBe('declined');
  });

  it('shows the reason a send failed', () => {
    expect(mount(action({ state: 'failed', detail: 'channel_not_found' })).textContent).toContain(
      'channel_not_found',
    );
  });
});

describe('the message', () => {
  it('is FOLDED, because the card sits in what you are scrolling', () => {
    const box = mount(action());
    expect(box.textContent).not.toContain('the build is green');
    const toggle = box.querySelector('.action-card__toggle') as HTMLButtonElement;
    act(() => toggle.click());
    // …and never a round trip: it was there all along.
    expect(box.textContent).toContain('the build is green');
  });

  it('has no toggle at all when there is nothing to show', () => {
    expect(mount(action({ body: null })).querySelector('.action-card__toggle')).toBeNull();
  });
});

describe('the link', () => {
  it('appears only when the outside system gave us one', () => {
    expect(mount(action()).querySelector('.action-card__link')).toBeNull();
    const withUrl = mount(action({ url: 'https://slack.example/p1' }));
    const a = withUrl.querySelector('.action-card__link') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://slack.example/p1');
    // A new tab, and no window.opener back into muxpad.
    expect(a.getAttribute('rel')).toContain('noopener');
  });
});

describe('the mark says WHICH integration', () => {
  it('gives Slack its logo', () => {
    const box = mount(action({ kind: 'slack.post' }));
    expect(box.querySelector('.action-card__glyph svg')?.getAttribute('aria-label')).toBe('Slack');
  });

  it('gives publish a globe, not the unknown-integration arrow', () => {
    // It fell through to the fallback on its first outing, so the commonest
    // card in the log wore the mark that means "this client has never heard of
    // this". A circle is the cheapest thing to assert that the arrow has not.
    const svg = mount(action({ kind: 'publish.create' })).querySelector('.action-card__glyph svg');
    expect(svg?.querySelector('circle')).not.toBeNull();
  });

  it('draws every integration the server can actually produce', () => {
    // The guard against the above happening to the NEXT one: a kind muxpad
    // ships must not share the fallback with a kind it has never seen.
    const unknown = mount(action({ kind: 'carrier-pigeon.send' })).querySelector(
      '.action-card__glyph svg',
    )?.innerHTML;
    for (const kind of ['slack.post', 'publish.create']) {
      const mine = mount(action({ kind })).querySelector('.action-card__glyph svg')?.innerHTML;
      expect(mine, `${kind} is still drawing the unknown-integration mark`).not.toBe(unknown);
    }
  });
});

describe('an integration this client has never heard of', () => {
  it('still renders a card', () => {
    // A client older than the server WILL meet kinds it does not know, and a
    // dropped row is a missing piece of the record.
    const box = mount(action({ kind: 'carrier-pigeon.send', title: 'Dispatched a pigeon' }));
    expect(box.textContent).toContain('Dispatched a pigeon');
    expect(box.querySelector('.action-card__glyph svg')).not.toBeNull();
  });
});

describe('where the cards land', () => {
  const entry = (at: number | null) => ({ at, node: `e${at}` });

  it('go at the point in the log where the act happened', () => {
    const out = injectActionCards(
      [entry(100), entry(300)],
      [action({ id: 'x', at: 200 })],
      (a) => `card:${a.id}`,
      { floor: 100 },
    );
    expect(out.map((o) => o.node)).toEqual(['e100', 'card:x', 'e300']);
  });

  it('are NOT piled at the head when they predate the loaded window', () => {
    // The bug lib/log-window exists for: anything older than the oldest loaded
    // message satisfies the test against the FIRST entry and lands there.
    const out = injectActionCards(
      [entry(500)],
      [action({ id: 'old', at: 10 })],
      (a) => `card:${a.id}`,
      { floor: 500 },
    );
    expect(out.map((o) => o.node)).toEqual(['e500']);
  });

  it('are NOT flushed at the tail before the log has a timeline', () => {
    const out = injectActionCards(
      [entry(null)],
      [action({ id: 'x', at: 200 })],
      (a) => `card:${a.id}`,
      { floor: null },
    );
    expect(out.map((o) => o.node)).toEqual(['enull']);
  });
});
