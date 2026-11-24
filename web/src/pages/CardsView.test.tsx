import type { CardChat, CardWithChat } from '@muxpad/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE CARDS PAGE. Its data shape is the route's (routes/cards.all.test.ts);
 * what is asserted here is the three decisions the PAGE makes, each of which
 * is the reason it exists rather than a styling choice:
 *
 *   · OVERDUE FIRST. The page is for "which of my watchers stopped", and a
 *     card that has gone quiet is indistinguishable from a healthy one inside
 *     its own chat. If the order stops answering that, the page is a grid.
 *   · THE ARCHIVE IS SEPARATE AND PRESENT. Cards on chats that have left the
 *     live list are litter, and they accumulate precisely because nobody can
 *     see them — so they are grouped away, not hidden.
 *   · EVERY TILE LEADS BACK. A value with no route to the conversation that
 *     produced it is a number with no author.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

const card = (
  name: string,
  // `Omit` the chat before making it partial: intersecting `Partial<
  // CardWithChat>` with a partial chat leaves `CardChat & Partial<CardChat>`,
  // which is just CardChat — so every call would have to spell out all six
  // fields. Caught by typecheck, which vitest does not run.
  over: Partial<Omit<CardWithChat, 'chat'>> & { chat?: Partial<CardChat> } = {},
): CardWithChat =>
  ({
    id: `c-${name}`,
    tab_id: 't1',
    name,
    content: name,
    format: 'text',
    every_ms: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
    chat: {
      tabId: 't1',
      name: 'Investing',
      slug: 's-t1',
      workspaceSlug: 'personal',
      workspaceName: 'Personal',
      retired: false,
      ...(over.chat ?? {}),
    },
  }) as CardWithChat;

let payload: CardWithChat[] = [];

// The tiles link with the router's <Link>; this page's identity is what it
// lists and in what order, not the routing, which the router's test covers.
// `to`/`params` are rendered as data so the "leads back" assertion can read
// the destination without mounting a router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    className,
  }: {
    children?: unknown;
    params?: { wsSlug: string; tabSlug: string };
    className?: string;
  }) => (
    <a className={className} href={`/w/${params?.wsSlug}/t/${params?.tabSlug}`}>
      {children as never}
    </a>
  ),
}));
vi.mock('../use-document-title', () => ({ useDocumentTitle: () => {} }));

const { CardsView } = await import('./CardsView');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  payload = [];
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ cards: payload }) })),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render and let the initial fetch settle. */
const render = async () => {
  await act(async () => {
    root.render(<CardsView />);
  });
  return host;
};

const tileNames = (el: HTMLElement, scope = '.cards-grid:not(.-archive)') =>
  [...el.querySelectorAll(`${scope} .cards-tile-name`)].map((n) => n.textContent);

describe('the cards page', () => {
  it('says what to do instead of showing an empty grid', async () => {
    const el = await render();
    expect(el.querySelector('.mcl-empty-title')?.textContent).toContain('No cards');
    expect(el.querySelector('.cards-grid')).toBeNull();
  });

  it('puts the overdue first — the question the page is for', async () => {
    payload = [
      // Fresh, and newest: the server's order would lead with this.
      card('market', { every_ms: 60_000, updated_at: NOW }),
      // Silent for twenty times its declared cadence. Nothing inside its own
      // chat says so; here it must come first.
      card('nas', { every_ms: 60_000, updated_at: NOW - 20 * 60_000 }),
    ];
    expect(tileNames(await render())).toEqual(['nas', 'market']);
  });

  it('marks the overdue one, and leaves the others alone', async () => {
    payload = [
      card('nas', { every_ms: 60_000, updated_at: NOW - 20 * 60_000 }),
      card('market', { every_ms: 60_000, updated_at: NOW }),
    ];
    const el = await render();
    const tiles = [...el.querySelectorAll('.cards-grid:not(.-archive) .cards-tile')];
    expect(tiles[0]?.className).toContain('-stale');
    expect(tiles[1]?.className).not.toContain('-stale');
  });

  it('never calls a card with no declared cadence late', async () => {
    // A writer that never promised to come back is not overdue, however old
    // the value is — the same rule `cardIsStale` holds the chat to.
    payload = [card('idea-engine', { every_ms: null, updated_at: NOW - 400 * 86_400_000 })];
    const el = await render();
    expect(el.querySelector('.cards-tile')?.className).not.toContain('-stale');
  });

  it('separates the cards whose chat is archived, and still shows them', async () => {
    payload = [
      card('market'),
      card('leftover', { chat: { retired: true, name: 'Finished thing' } }),
    ];
    const el = await render();
    expect(tileNames(el)).toEqual(['market']);
    expect(tileNames(el, '.cards-grid.-archive')).toEqual(['leftover']);
    expect(el.querySelector('.cards-archive-head')?.textContent).toContain('finished with');
  });

  it('gives the archived ones the only clear button on the page', async () => {
    // A live card is cleared from its own chat, where whoever writes it can be
    // told it is gone. These have no such chat left.
    payload = [card('market'), card('leftover', { chat: { retired: true } })];
    const el = await render();
    const clears = [...el.querySelectorAll('.cards-tile-clear')];
    expect(clears).toHaveLength(1);
    expect(clears[0]?.closest('.cards-grid')?.className).toContain('-archive');
  });

  it('every tile leads back to the chat that owns it', async () => {
    payload = [card('market', { chat: { workspaceSlug: 'personal', slug: 's-inv' } })];
    const el = await render();
    expect(el.querySelector<HTMLAnchorElement>('.cards-tile-chat')?.getAttribute('href')).toBe(
      '/w/personal/t/s-inv',
    );
  });

  it('names an untitled chat rather than printing nothing', async () => {
    payload = [card('market', { chat: { name: '' } })];
    const el = await render();
    expect(el.querySelector('.cards-tile-chat')?.textContent).toContain('untitled chat');
  });
});
