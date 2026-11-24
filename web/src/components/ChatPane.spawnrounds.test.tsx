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
const corpusFeed = vi.hoisted(() => ({
  current: [] as unknown[],
  listener: null as ((groups: unknown[]) => void) | null,
}));

vi.mock('../lib/spawn-rounds', () => ({
  NO_ROUNDS: new Map(),
  loadSpawnRounds: vi.fn(async (tabId: string, changed = false) => {
    loads.push({ tabId, changed });
    return new Map();
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
  corpusFeed.listener = null;
});

async function mount(rows: Row[]) {
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
    root!.render(<ChatPane paneId={`${PARENT}-pane`} tabId={PARENT} active agentNative />),
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

  it('stops the net when the conversation closes', async () => {
    await mount([tab(PARENT), child(), tab('stranger')]);
    loads.length = 0;
    await act(async () => root?.unmount());
    root = undefined;
    await advance(SPAWN_ROUNDS_NET_MS * 3);
    expect(mine()).toEqual([]);
  });

  it('asks nothing at all — not even the net — for a chat that has spawned nothing', async () => {
    await mount([tab(PARENT), tab('stranger')]);
    await publish([tab(PARENT), tab('stranger', { status: 'working' })]);
    await advance(SPAWN_ROUNDS_NET_MS * 3);
    expect(mine()).toEqual([]);
  });
});
