import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MentionChat, toMentionChats } from '../lib/chat-mention';
import type { WorkspaceTabs } from '../lib/nav-search';
import { ChatPane, SPAWN_ROUNDS_NET_MS, spawnRoundsSignature } from './ChatPane';

/**
 * A CONVERSATION ASKS FOR ITS ROUNDS WHEN ITS OWN CHILDREN MOVE — NOT WHEN
 * ANYTHING ON THE INSTALL DOES.
 *
 * The effect forced a fresh `/api/tabs/:id/spawn-rounds` on every corpus change,
 * and the corpus changes whenever any agent anywhere changes state. Measured on
 * the live server: one idle viewer of a coordinator chat asked 47 times a minute
 * for 237 KB at 100–200 ms of server time apiece — on the single thread every
 * chat open queues behind.
 *
 * Two halves are pinned here. The SIGNATURE moves for every child field a round
 * moves, and for nothing else; and the EFFECT reads only when the signature
 * moved, plus one slow safety-net read a minute — never because some other
 * corpus patch landed, cached or not.
 */

const loads = vi.hoisted(() => [] as Array<{ tabId: string; changed: boolean }>);
/** What the loader answers, per parent; a parent missing here gets an empty map,
 *  and one mapped to `'pending'` never answers. */
const answers = vi.hoisted(() => new Map<string, unknown>());
const corpusFeed = vi.hoisted(() => ({
  current: [] as unknown[],
  listener: null as ((groups: unknown[]) => void) | null,
}));

/** Every card list ChatPane derived, newest last — what the log would draw. */
const drawn = vi.hoisted(() => [] as Array<Array<{ chat: { tabId: string }; kind: string }>>);
vi.mock('../lib/chat-mention', async (original) => {
  const real = await original<typeof import('../lib/chat-mention')>();
  return {
    ...real,
    spawnCards: (...args: Parameters<typeof real.spawnCards>) => {
      const out = real.spawnCards(...args);
      drawn.push(out);
      return out;
    },
  };
});
const cardsNow = () => (drawn.at(-1) ?? []).map((c) => `${c.kind}:${c.chat.tabId}`);

vi.mock('../lib/spawn-rounds', () => ({
  NO_ROUNDS: new Map(),
  loadSpawnRounds: vi.fn(async (tabId: string, changed = false) => {
    loads.push({ tabId, changed });
    const a = answers.get(tabId);
    if (a === 'pending') return new Promise(() => {});
    return a ?? new Map();
  }),
}));
vi.mock('../lib/all-tabs', async (original) => ({
  ...(await original<object>()),
  cachedAllTabs: () => corpusFeed.current,
  loadAllTabs: async () => corpusFeed.current,
  subscribeAllTabs: (fn: (groups: unknown[]) => void) => {
    corpusFeed.listener = fn;
    return () => {
      corpusFeed.listener = null;
    };
  },
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => () => {},
}));
vi.mock('./SlackApprovalAlert', () => ({ SlackApprovalAlert: () => null }));

type Row = Record<string, unknown> & { id: string };

function tab(id: string, extra: Record<string, unknown> = {}): Row {
  return {
    id,
    slug: id,
    name: id,
    layout: `${id}-pane`,
    workspace_id: 'ws',
    position: 0,
    created_at: 1_000,
    updated_at: 1_000,
    status: 'idle',
    ...extra,
  };
}

const PARENT = 'parent';
const child = (extra: Record<string, unknown> = {}) =>
  tab('kid', {
    spawned_by: PARENT,
    created_at: 2_000,
    last_user_at: 2_000,
    status: 'working',
    spawn_task: 'do the thing',
    ...extra,
  });

function groups(rows: Row[]): WorkspaceTabs[] {
  return [{ id: 'ws', slug: 'ws', name: 'ws', tabs: rows as never }];
}
const chats = (rows: Row[]): MentionChat[] => toMentionChats(groups(rows));
const sig = (rows: Row[]) => spawnRoundsSignature(chats(rows), PARENT);

describe('the signature moves with the rounds, and with nothing else', () => {
  const base = [tab(PARENT), child(), tab('stranger')];

  it('is empty for a chat with no children — nothing to ask for', () => {
    expect(spawnRoundsSignature(chats([tab(PARENT), tab('stranger')]), PARENT)).toBe('');
    expect(spawnRoundsSignature(chats(base), undefined)).toBe('');
  });

  // Every child field that moves when a round opens, ends or gets its result.
  const roundBearing: Array<[string, Record<string, unknown>]> = [
    ['a round opening (the send that hands it a job)', { last_user_at: 9_000 }],
    ['the turn ending', { status: 'ready' }],
    ['retiring', { done: true }],
    ['the retirement reason', { done: true, done_reason: 'delivered' }],
    ['the retirement stamp', { done: true, done_at: 9_000 }],
    ['a new job', { spawn_task: 'the next thing' }],
    ['a report landing', { spawn_report_state: 'ok', spawn_report_at: 9_000 }],
    ['a new artifact', { spawn_artifacts: ['/tmp/out.md'] }],
    ['a new child', {}],
  ];
  for (const [what, change] of roundBearing) {
    it(`moves for ${what}`, () => {
      const after =
        what === 'a new child'
          ? [...base, tab('kid-2', { spawned_by: PARENT })]
          : [tab(PARENT), child(change), tab('stranger')];
      expect(sig(after)).not.toBe(sig(base));
    });
  }

  it('moves when an EXISTING report is rewritten, not only when one first lands', () => {
    const first = [tab(PARENT), child({ spawn_report_state: 'ok', spawn_report_at: 9_000 })];
    const again = [tab(PARENT), child({ spawn_report_state: 'ok', spawn_report_at: 9_500 })];
    expect(sig(again)).not.toBe(sig(first));
  });

  it('holds still for everything that is not one of this chat’s rounds', () => {
    const noise = [
      tab(PARENT, { status: 'working', headline: 'busy', last_activity_at: 99_999 }),
      child({ headline: 'narrating', last_activity_at: 99_999, unread: true }),
      tab('stranger', { status: 'working', last_user_at: 99_999 }),
      tab('elsewhere-kid', { spawned_by: 'someone-else', status: 'working' }),
    ];
    expect(sig(noise)).toBe(sig(base));
  });
});

// ── The effect, mounted ──────────────────────────────────────────────────────

class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
}

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  loads.length = 0;
  answers.clear();
  drawn.length = 0;
  corpusFeed.listener = null;
});

async function mount(rows: Row[], parent = PARENT) {
  corpusFeed.current = groups(rows);
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  for (const name of ['ResizeObserver', 'IntersectionObserver'])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<ChatPane paneId={`${parent}-pane`} tabId={parent} active agentNative />),
  );
}

async function show(parent: string) {
  await act(async () =>
    root!.render(<ChatPane paneId={`${parent}-pane`} tabId={parent} active agentNative />),
  );
}

async function publish(rows: Row[]) {
  corpusFeed.current = groups(rows);
  await act(async () => corpusFeed.listener?.(corpusFeed.current));
}

const mine = () => loads.filter((l) => l.tabId === PARENT);

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** The rest of the install keeps working: the corpus moves, the children do not. */
const churn = (i: number) => [
  tab(PARENT, { headline: `parent ${i}` }),
  child({ headline: `step ${i}`, last_activity_at: i }),
  tab('stranger', { status: i % 2 ? 'working' : 'ready', last_activity_at: i }),
];

describe('the conversation reads its rounds only when its children move', () => {
  it('reads once on open, then NOTHING for 30 s of corpus churn', async () => {
    await mount([tab(PARENT), child(), tab('stranger')]);
    expect(mine()).toEqual([{ tabId: PARENT, changed: true }]);
    loads.length = 0;
    // Forty busy agents: a corpus patch every second for 30 s.
    for (let i = 1; i <= 30; i++) {
      await publish(churn(i));
      await advance(1_000);
    }
    expect(mine()).toEqual([]);
  });

  it('forces a read the moment a child’s report lands', async () => {
    await mount([tab(PARENT), child(), tab('stranger')]);
    await publish(churn(1));
    loads.length = 0;
    await publish([
      tab(PARENT),
      child({ spawn_report_state: 'ok', spawn_report_at: 9_000 }),
      tab('stranger', { status: 'working' }),
    ]);
    expect(mine()).toEqual([{ tabId: PARENT, changed: true }]);
  });

  it('still re-reads once a minute, for rounds that change without their row', async () => {
    await mount([tab(PARENT), child(), tab('stranger')]);
    loads.length = 0;
    await advance(SPAWN_ROUNDS_NET_MS - 1_000);
    expect(mine()).toEqual([]);
    await advance(1_000);
    expect(mine()).toHaveLength(1);
    await advance(SPAWN_ROUNDS_NET_MS);
    expect(mine()).toHaveLength(2);
  });

  // EVERY VISITED CHAT STAYS MOUNTED (AppLayout keeps the hosts alive), so a
  // net with no `active` guard meant a session that had opened eight
  // coordinators ran eight of them forever, each re-reading every child's
  // rounds a minute apart for a pane nobody was looking at. Found by review.
  it('runs no net for a conversation that is mounted but not in front of you', async () => {
    await mount([tab(PARENT), child(), tab('stranger')]);
    loads.length = 0;
    await act(async () =>
      root?.render(
        <ChatPane paneId={`${PARENT}-pane`} tabId={PARENT} active={false} agentNative />,
      ),
    );
    await advance(SPAWN_ROUNDS_NET_MS * 3);
    expect(mine()).toEqual([]);
    // Come back to it and the net resumes.
    await show(PARENT);
    await advance(SPAWN_ROUNDS_NET_MS);
    expect(mine()).toHaveLength(1);
  });

  it('stops the net when the conversation closes', async () => {
    await mount([tab(PARENT), child(), tab('stranger')]);
    loads.length = 0;
    await act(async () => root?.unmount());
    root = undefined;
    await advance(SPAWN_ROUNDS_NET_MS * 3);
    expect(mine()).toEqual([]);
  });

  it('asks ONCE, and runs no net, for a chat whose answer names no children', async () => {
    // Once, because an empty corpus signature no longer means "spawned
    // nothing": the corpus carries live work only.
    await mount([tab(PARENT), tab('stranger')]);
    await publish([tab(PARENT), tab('stranger', { status: 'working' })]);
    await advance(SPAWN_ROUNDS_NET_MS * 3);
    expect(mine()).toEqual([{ tabId: PARENT, changed: true }]);
  });
});

// ── Finished children live in the rounds answer, not the corpus ──────────────

/** A rounds answer carrying one finished child the corpus no longer has. */
function finishedAnswer(
  parent: string,
  id: string,
  task: string,
  extra: Record<string, unknown> = {},
) {
  const row = tab(id, {
    spawned_by: parent,
    created_at: 2_000,
    status: 'ready',
    done: true,
    done_reason: 'delivered',
    done_at: 3_000,
    spawn_task: task,
    ...extra,
  });
  return Object.assign(new Map(), { children: chats([row]) });
}

describe('a conversation whose workers have all finished', () => {
  it('asks for its rounds by its OWN tab id, even absent from the corpus', async () => {
    // A finished parent: no row of its own in the live corpus, no children.
    await mount([tab('stranger')]);
    expect(mine()).toEqual([{ tabId: PARENT, changed: true }]);
  });

  it('draws the cards of children only the rounds answer knows', async () => {
    answers.set(PARENT, finishedAnswer(PARENT, 'gone', 'Audit the card lane'));
    await mount([tab(PARENT), tab('stranger')]);
    expect(cardsNow()).toEqual(['launch:gone', 'completion:gone']);
  });

  it('keeps the net running for children only the answer names', async () => {
    // A late report on a child already gone from the corpus moves no corpus
    // row; the minute net is the only thing that will see it.
    answers.set(PARENT, finishedAnswer(PARENT, 'gone', 'Audit the card lane'));
    await mount([tab(PARENT), tab('stranger')]);
    loads.length = 0;
    await advance(SPAWN_ROUNDS_NET_MS);
    expect(mine()).toHaveLength(1);
  });

  it('never shows the PREVIOUS conversation’s cards after a switch', async () => {
    answers.set(PARENT, finishedAnswer(PARENT, 'gone', 'Audit the card lane'));
    answers.set('other', 'pending');
    await mount([tab(PARENT), tab('other'), tab('stranger')]);
    expect(cardsNow()).toEqual(['launch:gone', 'completion:gone']);
    await show('other');
    expect(loads.at(-1)).toEqual({ tabId: 'other', changed: true });
    expect(cardsNow()).toEqual([]);
    // …nor keep acting on its answer: `other` has no children anywhere yet, so
    // the previous parent's must not arm a minute net for it.
    loads.length = 0;
    await advance(SPAWN_ROUNDS_NET_MS * 2);
    expect(loads).toEqual([]);
  });
});

// ── The DRAWER reads the same children as the cards ──────────────────────────

describe('the work drawer, once its workers have finished', () => {
  const openDrawer = async () => {
    const toggle = host?.querySelector<HTMLButtonElement>('.chat-drawer-open');
    expect(toggle).toBeTruthy();
    await act(async () => toggle?.click());
  };
  const drawerNames = () =>
    [...(host?.querySelectorAll('.chat-drawer__row-name') ?? [])].map((n) => n.textContent);

  it('lists a finished child only the rounds answer knows', async () => {
    answers.set(PARENT, finishedAnswer(PARENT, 'gone', 'Audit the card lane'));
    await mount([tab(PARENT), tab('stranger')]);
    await openDrawer();
    expect(drawerNames()).toEqual(['Audit the card lane']);
  });

  it('the closed toggle counts what the drawer counts — a worker still waiting on you', async () => {
    // Decayed off the live list with a question outstanding: `awaiting`, so the
    // drawer calls it open, and the toggle's badge has to say so too.
    answers.set(
      PARENT,
      finishedAnswer(PARENT, 'asks', 'Ask about the cap', {
        done_reason: 'decayed',
        spawn_report_state: 'awaiting',
        spawn_report_at: 3_000,
      }),
    );
    await mount([tab(PARENT), tab('stranger')]);
    expect(host?.querySelector('.chat-drawer-open')?.getAttribute('data-running')).toBe('true');
  });

  it('lists them for a FINISHED parent too, absent from the corpus itself', async () => {
    answers.set(PARENT, finishedAnswer(PARENT, 'gone', 'Audit the card lane'));
    await mount([tab('stranger')]);
    await openDrawer();
    expect(drawerNames()).toEqual(['Audit the card lane']);
  });
});
