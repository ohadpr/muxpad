import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatAction, Tab } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MentionChat, toMentionChats } from '../lib/chat-mention';
import { artifactsOf, subChatsOf } from '../lib/sub-chats';
import { ChatDrawer } from './ChatDrawer';

/**
 * The publish LISTING, which the artifacts tab fetches on mount.
 *
 * Mocked because jsdom has no server: unmocked it rejects, the tab catches it
 * and renders no term at all — so every assertion about a link's shelf life
 * would have been passing on an empty render. (That is the same shape as the
 * bug this tab shipped with: a mock agreeing with the code while the real
 * route disagreed with both. server/src/routes/publish-api.test.ts is what
 * holds this mock honest about the field names.)
 */
const listing = vi.hoisted(() => ({
  value: null as { publishes: unknown[] } | null,
}));
vi.mock('../api', () => ({
  api: {
    listPublished: async () => listing.value ?? { publishes: [] },
    extendPublish: async () => ({}),
    expirePublish: async () => ({}),
  },
  ApiError: class extends Error {},
}));

/**
 * THE WORK DRAWER — what a chat has going on beside itself.
 *
 * Two properties carry the whole feature, and both are about FINDING things:
 *   · every worker is in the list, running and finished alike (the four
 *     previous homes for a sub-chat each lost one of those halves);
 *   · opening one shows the real chat, in place, without leaving the
 *     conversation you were reading.
 */

const NOW = 1_800_000_000_000;

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    slug: id,
    name: id,
    workspace_id: 'w1',
    // A layout leaf IS the pane id (shared/src/layout.ts) — which is how a
    // row knows what to mount.
    layout: `${id}-p`,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  } as Tab;
}

/** The real corpus builder, so these rows are the ones the app holds. */
const corpusOf = (tabs: Tab[]): MentionChat[] =>
  toMentionChats([{ id: 'w1', slug: 'w', name: 'W', tabs }] as never);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function mount(props: Partial<Parameters<typeof ChatDrawer>[0]> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const full = {
    tabId: 'parent',
    corpus: [],
    actions: [],
    tab: 'subchats' as const,
    onTab: () => {},
    openPaneId: null,
    onOpenChat: () => {},
    onClose: () => {},
    renderChat: () => <div data-testid="mounted-chat" />,
    ...props,
  };
  act(() => root?.render(<ChatDrawer {...full} />));
  return host as HTMLDivElement;
}

describe('the sub-chats list', () => {
  const family = () =>
    corpusOf([
      tab('parent'),
      tab('running', { spawned_by: 'parent', done: false, status: 'working' }),
      tab('reported', { spawned_by: 'parent', done: true }),
    ]);

  it('holds the finished ones AND the running ones', () => {
    // Each earlier home for a sub-chat lost one of these halves: the done
    // drawer held only the delivered, the rail's live nesting only the
    // unfinished, and dropping them entirely lost both.
    const box = mount({ corpus: family() });
    expect(box.textContent).toContain('running');
    expect(box.textContent).toContain('reported');
  });

  it('counts the RUNNING ones on the tab, not the total', () => {
    // The total is how much history there is, and nobody is waiting on
    // history.
    const box = mount({ corpus: family() });
    const subsTab = box.querySelectorAll('.chat-drawer__tab')[0];
    expect(subsTab?.textContent).toContain('1');
  });

  it('lists ONE HOP, not the whole tree', () => {
    // A grandchild belongs in ITS parent's drawer. Flattening the tree here
    // would show a chat work it never asked for — the rail's grouping
    // flattens, and that is a different question (see lib/sub-chats).
    const box = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('child', { spawned_by: 'parent' }),
        tab('grandchild', { spawned_by: 'child' }),
      ]),
    });
    expect(box.textContent).toContain('child');
    expect(box.textContent).not.toContain('grandchild');
  });

  it('says what it is for when there is nothing in it', () => {
    // A control that appears only once there is something in it cannot be
    // learned. The button is always there, so the panel has to explain itself.
    expect(mount().textContent).toMatch(/Nothing yet/i);
  });

  it('opens a row into the real chat, mounted in place', () => {
    const subs = subChatsOf(family(), 'parent');
    const picked = vi.fn();
    const box = mount({ corpus: family(), onOpenChat: picked });
    const row = box.querySelectorAll('.chat-drawer__row')[0] as HTMLButtonElement;
    act(() => row.click());
    expect(picked).toHaveBeenCalled();
    // And with the pane to mount — a row whose pane is gone cannot be opened.
    expect(subs[0]?.paneId).toBeTruthy();
  });

  it('shows the chat the caller says is open, not a preview of it', () => {
    const box = mount({
      corpus: family(),
      openPaneId: subChatsOf(family(), 'parent')[0]?.paneId ?? null,
    });
    expect(box.querySelector('[data-testid="mounted-chat"]')).not.toBeNull();
    // …and a way back to the list that is NOT the close button: two exits, or
    // glancing at two workers costs four clicks.
    expect(box.querySelector('.chat-drawer__back')).not.toBeNull();
    expect(box.querySelector('.chat-drawer__close')).not.toBeNull();
  });
});

describe('the artifacts list', () => {
  const published = (over: Partial<ChatAction> = {}): ChatAction => ({
    id: 'a1',
    pane_id: 'p1',
    at: NOW,
    kind: 'publish.create',
    title: 'Published weekly-report',
    url: 'https://pub.example/weekly-report-ab12/',
    state: 'sent',
    detail: '3 files',
    ...over,
  });

  it('lists what this chat put on the internet, with its link', () => {
    const box = mount({ tab: 'artifacts', actions: [published()] });
    const link = box.querySelector('.chat-drawer__row--artifact') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://pub.example/weekly-report-ab12/');
    expect(box.textContent).toContain('weekly-report');
    expect(box.textContent).toContain('3 files');
  });

  /**
   * THE NAME IS THE ONLY THING THAT TELLS TWO ROWS APART.
   *
   * Reported with a screenshot of 31 rows: "no way to really know what each
   * one of these is". Every row opened with `Published` — the one word they
   * all share, and the tab is already called Artifacts — and the name was
   * then cut at about twelve characters, so four different links all read
   * `Published muxpad-run…`.
   */
  it('drops the `Published` verb, which every row repeated', () => {
    const box = mount({ tab: 'artifacts', actions: [published()] });
    const name = box.querySelector('.chat-drawer__row-name') as HTMLElement;
    expect(name.textContent).toBe('weekly-report');
    expect(box.textContent).not.toContain('Published');
    // The whole name is reachable even when the column clips it.
    expect(name.getAttribute('title')).toBe('weekly-report');
  });

  it('collapses republishes of one url into one row', () => {
    // `--update` keeps the slug so an existing link keeps working, and every
    // republish wrote another row: a real list came back with seven rows
    // reading `muxpad-work-drawer`. They are one artifact at one address.
    const box = mount({
      tab: 'artifacts',
      actions: [
        published({ id: 'a1', at: NOW }),
        published({ id: 'a2', at: NOW - 1000 }),
        published({ id: 'a3', at: NOW - 2000 }),
      ],
    });
    expect(box.querySelectorAll('.chat-drawer__artifact')).toHaveLength(1);
    // …and the row says it has been published more than once.
    expect(box.textContent).toContain('×3');
  });

  it('keeps genuinely different artifacts apart', () => {
    const box = mount({
      tab: 'artifacts',
      actions: [
        published({ id: 'a1', url: 'https://pub.example/one-ab12/' }),
        published({ id: 'a2', url: 'https://pub.example/two-cd34/' }),
      ],
    });
    expect(box.querySelectorAll('.chat-drawer__artifact')).toHaveLength(2);
    // Scoped to the ROWS: the panel's close button is an × too.
    const subs = [...box.querySelectorAll('.chat-drawer__row-sub')].map((e) => e.textContent);
    expect(subs.some((t) => t?.startsWith('×'))).toBe(false);
  });

  it('says when a link is gone, rather than showing a bare row', async () => {
    // `publishTerm` answers null both for a link with no expiry and for one
    // the server has never heard of, so a taken-down artifact looked exactly
    // like a healthy permanent one. The listing having loaded is what tells
    // them apart.
    listing.value = { publishes: [] };
    const box = mount({ tab: 'artifacts', actions: [published()] });
    await act(async () => {
      await Promise.resolve();
    });
    const term = box.querySelector('.chat-drawer__term');
    expect(term?.textContent).toBe('removed');
    expect(term?.getAttribute('data-state')).toBe('expired');
  });

  it('drops `1 file`, which is not information', () => {
    // It was the same value on 29 of 31 rows. A count earns its place only
    // when there is more than one.
    const box = mount({ tab: 'artifacts', actions: [published({ detail: '1 file' })] });
    expect(box.textContent).not.toContain('1 file');
    const many = mount({ tab: 'artifacts', actions: [published({ detail: '4 files' })] });
    expect(many.textContent).toContain('4 files');
  });

  it('is a LINK, so it can be copied and middle-clicked', () => {
    const box = mount({ tab: 'artifacts', actions: [published()] });
    const link = box.querySelector('.chat-drawer__row--artifact') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows the NEWEST first — this is a place you come to fetch a link', () => {
    // Two DIFFERENT artifacts: same-url republishes collapse into one row
    // (see artifactsOf), so ordering has to be shown on distinct ones.
    const rows = artifactsOf([
      published({
        id: 'old',
        title: 'old one',
        url: 'https://pub.example/old-aa/',
        at: NOW - 1000,
      }),
      published({ id: 'new', title: 'new one', url: 'https://pub.example/new-bb/', at: NOW }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('ignores an act that is not a publish, and one with no url', () => {
    expect(
      artifactsOf([
        published({ id: 'slack', kind: 'slack.post' }),
        published({ id: 'nourl', url: null }),
      ]),
    ).toEqual([]);
  });

  it('says what it is for when empty', () => {
    expect(mount({ tab: 'artifacts' }).textContent).toMatch(/Nothing published/i);
  });
});

describe('the sub-chat list has shape', () => {
  // It was one flat run of identical rows in spawn order, so the worker still
  // going sat wherever it happened to start — usually last — and every row
  // spent a line of type on the same word.
  const names = (box: HTMLDivElement) =>
    [...box.querySelectorAll('.chat-drawer__row-name')].map((e) => e.textContent);
  const groups = (box: HTMLDivElement) =>
    [...box.querySelectorAll('.chat-drawer__group')].map((e) => e.textContent);

  it('puts the running ones first, whatever order they were spawned in', () => {
    const box = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('reported-first', { spawned_by: 'parent', done: true }),
        tab('still-going', { spawned_by: 'parent', status: 'working' }),
      ]),
    });
    expect(names(box)).toEqual(['still-going', 'reported-first']);
  });

  it('labels every block, with its count', () => {
    // An unlabelled single block looked like the old flat list and taught the
    // reader nothing about why the next one would have a heading.
    const both = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('a', { spawned_by: 'parent', status: 'working' }),
        tab('b', { spawned_by: 'parent', done: true }),
      ]),
    });
    expect(groups(both).map((g) => g?.replace(/\d+$/, ''))).toEqual(['Running', 'Today']);
    const onlyRunning = mount({
      corpus: corpusOf([tab('parent'), tab('a', { spawned_by: 'parent', status: 'working' })]),
    });
    expect(groups(onlyRunning).map((g) => g?.replace(/\d+$/, ''))).toEqual(['Running']);
  });

  it('says the state in a word, not in a second dot', () => {
    // Twenty-one identical dots say nothing, so STATE left the mark. Every row
    // keeps its identity tile — a row without one is a word — and every row
    // now says where it got to at the end of its line.
    const box = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('going', { spawned_by: 'parent', status: 'working' }),
        tab('reported', { spawned_by: 'parent', done: true }),
      ]),
    });
    const rows = [...box.querySelectorAll('.chat-drawer__row')];
    const rowFor = (name: string) =>
      rows.find((r) => r.querySelector('.chat-drawer__row-name')?.textContent === name);
    expect(rowFor('going')?.querySelector('.chat-drawer__row-live')).not.toBeNull();
    // A FINISHED ROW SAYS SO TOO, which is the opposite of what this asserted
    // until it was asked for directly: "in sub-chat list put a 'done' green
    // label on chats that are done". Leaving the end of the line empty made
    // the panel's one question — did this finish — something you inferred
    // from which block the row fell into.
    expect(rowFor('reported')?.querySelector('.chat-drawer__row-live')?.textContent).toBe('done');
  });

  it('shows how long ago on EVERY finished row, not only in Earlier', () => {
    // "All chats should show how long ago." Within a block the ages still
    // differ, and a list of work is read by when as much as by what.
    const box = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('today', { spawned_by: 'parent', done: true }),
        tab('older', { spawned_by: 'parent', done: true, created_at: NOW - 3 * 86_400_000 }),
      ]),
    });
    const ages = [...box.querySelectorAll('.chat-drawer__row-sub')].map((e) => e.textContent);
    expect(ages).toHaveLength(2);
    for (const a of ages) expect(a).toMatch(/\d/);
  });

  it('puts the newest finished one at the top of its block', () => {
    // The answer you want from a finished worker is the last one.
    const box = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('older', { spawned_by: 'parent', done: true, created_at: NOW - 60_000 }),
        tab('newer', { spawned_by: 'parent', done: true, created_at: NOW }),
      ]),
    });
    expect(names(box)).toEqual(['newer', 'older']);
  });
});

describe('a row reads as a chat, not a word', () => {
  it('gives every row the same mark — finished ones included', () => {
    // Removing the status dot was right; removing the ANCHOR left a list of
    // words. One repeated mark, not a glyph per chat: twenty-one different
    // icons is another kind of noise, and a worker has no identity you would
    // recognise the way you recognise a conversation you named.
    const box = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('going', { spawned_by: 'parent', status: 'working' }),
        tab('reported', { spawned_by: 'parent', done: true }),
      ]),
    });
    expect(box.querySelectorAll('.chat-drawer__row .chat-drawer__mark')).toHaveLength(2);
    // …and it is NOT a per-chat chip any more.
    expect(box.querySelector('.chat-drawer__row .chatchip')).toBeNull();
  });

  it('spins beside "working", and marks a finished row done', () => {
    const box = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('going', { spawned_by: 'parent', status: 'working' }),
        tab('reported', { spawned_by: 'parent', done: true, done_reason: 'delivered' }),
        tab('stopped', { spawned_by: 'parent', done: true }),
      ]),
    });
    const rows = [...box.querySelectorAll('.chat-drawer__row')];
    const rowFor = (name: string) =>
      rows.find((r) => r.querySelector('.chat-drawer__row-name')?.textContent === name);
    expect(rowFor('going')?.querySelector('.chat-drawer__row-live')?.textContent).toBe('working');
    // The spinner is the part that reads as "right now" at a glance — a word
    // alone looks the same whether the worker is going or stopped.
    expect(rowFor('going')?.querySelector('.chat-drawer__spin')).not.toBeNull();
    const done = rowFor('reported')?.querySelector('.chat-drawer__row-live');
    expect(done?.textContent).toBe('done');
    // …and it is NOT spinning. A finished row with motion on it is a lie.
    expect(rowFor('reported')?.querySelector('.chat-drawer__spin')).toBeNull();
    // Green comes from the status channel, by state, in the stylesheet — and
    // only a worker that DELIVERED gets it. A chat that was archived or
    // decayed says "done" too, in grey: both are over, but only one of them
    // handed anything back.
    expect(done?.getAttribute('data-state')).toBe('delivered');
    const stopped = rowFor('stopped')?.querySelector('.chat-drawer__row-live');
    expect(stopped?.textContent).toBe('done');
    expect(stopped?.getAttribute('data-state')).toBe('done');
  });
});

describe('clicking away closes the panel', () => {
  const down = (el: Element | null) =>
    act(() => {
      el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });

  it('closes on a pointerdown in the page behind it', () => {
    const onClose = vi.fn();
    mount({ onClose });
    const behind = document.createElement('button');
    document.body.appendChild(behind);
    down(behind);
    expect(onClose).toHaveBeenCalledTimes(1);
    behind.remove();
  });

  it('does not close on a pointerdown inside itself', () => {
    const onClose = vi.fn();
    const h = mount({
      onClose,
      corpus: corpusOf([tab('parent'), tab('kid', { spawned_by: 'parent' })]),
    });
    down(h.querySelector('.chat-drawer__row'));
    down(h.querySelector('.chat-drawer'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on the toggle, which would make it reopen itself', () => {
    const onClose = vi.fn();
    mount({ onClose });
    // The button that opens the panel has its own handler; treating its click
    // as "outside" closes the panel and then the toggle reopens it, so the
    // panel looks like it is ignoring you.
    const toggle = document.createElement('button');
    toggle.className = 'chat-drawer-open';
    document.body.appendChild(toggle);
    down(toggle);
    expect(onClose).not.toHaveBeenCalled();
    toggle.remove();
  });

  it('does not close for a dialog opened above it', () => {
    const onClose = vi.fn();
    mount({ onClose });
    const dlg = document.createElement('dialog');
    dlg.innerHTML = '<button>Approve</button>';
    document.body.appendChild(dlg);
    down(dlg.querySelector('button'));
    expect(onClose).not.toHaveBeenCalled();
    dlg.remove();
  });

  it('stops listening once it is gone', () => {
    // Asserted on the LISTENER, not on the callback: after unmount the panel
    // ref is null, so a leaked listener would still call nothing and a test
    // watching `onClose` would pass while the leak grew one entry per open.
    const remove = vi.spyOn(document, 'removeEventListener');
    const onClose = vi.fn();
    mount({ onClose });
    act(() => root?.unmount());
    root = null;
    expect(
      remove.mock.calls.some(([type, , opts]) => type === 'pointerdown' && opts === true),
    ).toBe(true);
    remove.mockRestore();
  });
});

/**
 * ── PUBLISH, MANAGED WHERE YOU CAN SEE IT ────────────────────────────────
 *
 * 118 of 230 recorded actions are `publish.create` — the most-used thing
 * muxpad does — and this panel listed the links and nothing else. A link
 * 410s after seven days; the only place that was visible was a terminal.
 */
describe('the artifacts tab manages the links', () => {
  const SRC = readFileSync(join(__dirname, 'ChatDrawer.tsx'), 'utf8');

  it('shows each link’s remaining term', () => {
    expect(SRC).toContain('publishTerm(');
    expect(SRC).toMatch(/chat-drawer__row-live/);
  });

  it('can keep a link alive, and revive a dead one', () => {
    expect(SRC).toContain('api.extendPublish(rec.slug, 7)');
    expect(SRC).toMatch(/'Revive' : 'Keep 7d'/);
  });

  it('arms before taking one down — the one act others can notice', () => {
    expect(SRC).toContain('ArmedTakeDown');
    expect(SRC).toContain('api.expirePublish(rec.slug)');
    // …and it is still reversible: taking down stops the link, never the
    // files. `publish --rm` is the only thing that destroys bytes.
    expect(SRC).toMatch(/the link stops answering/);
  });

  it('still renders the links when the listing cannot be loaded', () => {
    // The term is extra; the address is the point. A failed fetch must not
    // take the rows with it.
    expect(SRC).toMatch(/\.catch\(\(\) => setLive\(null\)\)/);
  });
});
