import type { ChatAction, Tab } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MentionChat, toMentionChats } from '../lib/chat-mention';
import { artifactsOf, subChatsOf } from '../lib/sub-chats';
import { ChatDrawer } from './ChatDrawer';

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
    expect(box.textContent).toContain('Published weekly-report');
    expect(box.textContent).toContain('3 files');
  });

  it('is a LINK, so it can be copied and middle-clicked', () => {
    const box = mount({ tab: 'artifacts', actions: [published()] });
    const link = box.querySelector('.chat-drawer__row--artifact') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows the NEWEST first — this is a place you come to fetch a link', () => {
    const rows = artifactsOf([
      published({ id: 'old', title: 'old one', at: NOW - 1000 }),
      published({ id: 'new', title: 'new one', at: NOW }),
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

  it('labels the two blocks only when both exist', () => {
    const both = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('a', { spawned_by: 'parent', status: 'working' }),
        tab('b', { spawned_by: 'parent', done: true }),
      ]),
    });
    expect(groups(both)).toEqual(['Running', 'Finished']);
    // One group explains itself; a heading over the only block is furniture.
    const onlyRunning = mount({
      corpus: corpusOf([
        tab('parent'),
        tab('a', { spawned_by: 'parent', status: 'working' }),
        tab('b', { spawned_by: 'parent', status: 'working' }),
      ]),
    });
    expect(groups(onlyRunning)).toEqual([]);
  });

  it('gives a running row no second line, and a finished one the time', () => {
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
    // The running row's mark already says it, and the heading says it again.
    expect(rowFor('going')?.querySelector('.chat-drawer__row-sub')).toBeNull();
    expect(rowFor('reported')?.querySelector('.chat-drawer__row-sub')).not.toBeNull();
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
