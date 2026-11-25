import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTabs } from '../lib/nav-search';
import { ChatPane } from './ChatPane';

// Mount the real ChatPane and count its voice pass while the corpus changes.
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

async function publish(rows: Row[]) {
  corpusFeed.current = groups(rows);
  await act(async () => corpusFeed.listener?.(corpusFeed.current));
}

const voicePass = vi.hoisted(() => vi.fn());
vi.mock('../lib/chat-voice', async (original) => {
  const real = await original<typeof import('../lib/chat-voice')>();
  return {
    ...real,
    applyChatVoice: (...args: Parameters<typeof real.applyChatVoice>) => {
      voicePass();
      return real.applyChatVoice(...args);
    },
  };
});

describe('corpus churn does not reprocess the transcript', () => {
  it('skips the voice pipeline for unrelated pushes and report rewrites with unchanged completion membership', async () => {
    await mount([tab(PARENT), child(), tab('stranger')]);
    voicePass.mockClear();
    for (let i = 0; i < 30; i++)
      await publish([
        tab(PARENT, { headline: `parent ${i}` }),
        child({ headline: `step ${i}` }),
        tab('stranger', { name: `renamed ${i}` }),
      ]);
    expect(voicePass).not.toHaveBeenCalled();

    const finished = (text: string) =>
      child({
        done: true,
        status: 'ready',
        done_reason: 'delivered',
        done_at: 9000,
        spawn_report_state: 'ok',
        spawn_report_at: 9000,
        spawn_report: text,
      });
    await publish([tab(PARENT), finished('first')]);
    expect(voicePass).toHaveBeenCalledTimes(1);
    expect(cardsNow()).toContain('completion:kid');
    await publish([tab(PARENT), finished('rewritten report')]);
    expect(voicePass).toHaveBeenCalledTimes(1);
    await publish([tab(PARENT)]);
    expect(voicePass).toHaveBeenCalledTimes(2);
    expect(cardsNow()).not.toContain('completion:kid');
  });

  it('still reprocesses new transcript events', async () => {
    await mount([tab(PARENT)]);
    voicePass.mockClear();
    const socket = [...Socket.instances]
      .reverse()
      .find((s) => s.url.includes(`/ws/chat/${PARENT}-pane`))!;
    await act(async () =>
      socket.onmessage?.({
        data: JSON.stringify({
          t: 'events',
          events: [{ id: 'u', kind: 'user', text: 'hello', ts: 1 }],
        }),
      }),
    );
    expect(voicePass).toHaveBeenCalledTimes(1);
  });
});
