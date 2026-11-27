import { inboundTextKey, normalizeTranscriptLine, withMentionContext } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { resetAllTabsCache } from '../lib/all-tabs';
import { renderReportMarker } from '../lib/chat-mention';
import { resetInboundSendersCache } from '../lib/inbound-senders';
import { resetTabLookup } from '../lib/tab-lookup';
import { ChatPane } from './ChatPane';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => () => {},
}));
vi.mock('./SlackApprovalAlert', () => ({ SlackApprovalAlert: () => null }));

/**
 * `@` REACHES FINISHED HISTORY. The shared corpus carries live chats only, so a
 * chat archived last month comes from `/api/tabs/lookup` — and once picked it
 * has to SURVIVE the query closing: the send resolves the pick by id.
 */
class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: unknown[] = [];
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  frame(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const row = (id: string, layout: string, over: object = {}) => ({
  id,
  slug: id,
  name: id,
  layout,
  created_at: 1,
  updated_at: 1,
  ...over,
});
const BASE_LIVE = {
  workspaces: [{ id: 'w1', slug: 'w1', name: 'Home', tabs: [row('here', 'pane-here')] }],
};
let LIVE = BASE_LIVE;
const OLD = {
  workspaces: [
    {
      id: 'w2',
      slug: 'w2',
      name: 'Elsewhere',
      tabs: [row('quarterly-taxes', 'p-old', { done: true, done_reason: 'archived' })],
    },
  ],
};
const asked: string[] = [];
/** Extra finished rows every lookup answers with — e.g. THIS chat, finished. */
let EXTRA_OLD: ReturnType<typeof row>[] = [];
const oldAnswer = () =>
  EXTRA_OLD.length === 0
    ? OLD
    : { workspaces: [...OLD.workspaces, { id: 'w1', slug: 'w1', name: 'Home', tabs: EXTRA_OLD }] };
let SENDERS: Array<{ key: string; at: number; from_tab_id: string | null }> = [];

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetAllTabsCache();
  resetTabLookup();
  resetInboundSendersCache();
  asked.length = 0;
  LIVE = BASE_LIVE;
  SENDERS = [];
  EXTRA_OLD = [];
  localStorage.clear();
});

async function setup() {
  Socket.instances = [];
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
    vi.fn(async (url: string) => {
      asked.push(url);
      const body = url.startsWith('/api/tabs/all')
        ? LIVE
        : url.startsWith('/api/tabs/lookup?q=quart') ||
            url === '/api/tabs/lookup?paneIds=p-old' ||
            url === '/api/tabs/lookup?tabIds=quarterly-taxes' ||
            url === '/api/tabs/lookup?paneIds=pane-here'
          ? oldAnswer()
          : url === '/api/tabs/here/inbound-senders'
            ? { senders: SENDERS }
            : url.startsWith('/api/tabs/lookup')
              ? { workspaces: [] }
              : url.startsWith('/api/search') && /file|deduct/.test(url)
                ? {
                    // What was SAID in the finished chat: a content row would
                    // reopen the picker over the request if the run were not
                    // recognised as settled.
                    hits: [
                      {
                        sid: 's-old',
                        ts: 1,
                        role: 'assistant',
                        snippet: '«file these»',
                        session: { sid: 's-old', pane_id: 'p-old', cwd: null, assistant: null },
                      },
                    ],
                  }
                : url.startsWith('/api/search')
                  ? { hits: [] }
                  : [];
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<ChatPane paneId="pane-here" tabId="here" active agentNative />),
  );
  const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/pane-here'))!;
  await act(async () => {
    socket.readyState = Socket.OPEN;
    socket.onopen?.();
    socket.frame({
      t: 'session',
      mode: 'chat',
      hasMessages: false,
      turnRunning: false,
      session: null,
    });
  });
  return socket;
}
const draft = () => host.querySelector<HTMLElement>('.chat-input')!;
async function type(text: string) {
  await act(async () => {
    const d = draft();
    d.textContent = text;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(d);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    d.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** Load a conversation that HAS history, with these user messages in it. */
async function history(socket: Socket, texts: string[]) {
  await act(async () => {
    socket.frame({
      t: 'session',
      mode: 'chat',
      hasMessages: true,
      turnRunning: false,
      session: { current_sid: 'session', writer: 'runner', view_mode: 'chat', assistant: 'claude' },
    });
    socket.frame({
      t: 'events',
      events: texts.map((text, i) => ({ kind: 'user', id: `u${i}`, ts: Date.now(), text })),
    });
  });
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
}
const rows = () => [...host.querySelectorAll('.chat-mention-row')].map((r) => r.textContent);

it('finds a finished chat by name, and the pick survives to the send', async () => {
  const socket = await setup();
  await type('@quart');
  // Instant tier: the live corpus has nothing called that.
  expect(rows()).toEqual([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(asked).toContain('/api/tabs/lookup?q=quart');
  expect(rows()).toEqual([expect.stringContaining('quarterly-taxes')]);

  await act(async () => {
    host
      .querySelector<HTMLElement>('.chat-mention-row')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  // A CHIP in the composer, not plain text: the draft predicts the message, and
  // the pick is a finished chat the live corpus does not hold.
  expect(draft().querySelector('[data-draft-chat="quarterly-taxes"]')).not.toBeNull();
  // Past the one-frame latch that keeps the pick's own keyup from reopening it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  // The run is SETTLED once you type past the name — the picker must not hover
  // over the request, which needs the finished chat still in the picker corpus.
  await type('@quarterly-taxes file these');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(rows()).toEqual([]);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  const sent = socket.sent.find((m) => (m as { t?: string }).t === 'send') as
    | { text: string }
    | undefined;
  expect(sent?.text).toContain('p-old');
});

it('an archive hit in a finished chat resolves through the lookup, not the corpus', async () => {
  await setup();
  await type('@deductions');
  // The archive answers after its debounce; the pane lookup goes out on the
  // next tick after that answer renders.
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  expect(asked).toContain('/api/tabs/lookup?paneIds=p-old');
  expect(rows()).toEqual([expect.stringContaining('quarterly-taxes')]);
});

it('a looked-up finished chat ranks BELOW a live match, never above it', async () => {
  LIVE = {
    workspaces: [
      {
        id: 'w1',
        slug: 'w1',
        name: 'Home',
        tabs: [row('here', 'pane-here'), row('my-quart-plan', 'pane-plan')],
      },
    ],
  };
  await setup();
  await type('@quart');
  expect(rows()).toEqual([expect.stringContaining('my-quart-plan')]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(rows()).toEqual([
    expect.stringContaining('my-quart-plan'),
    expect.stringContaining('quarterly-taxes'),
  ]);
});

it('the LOG chips a mention of a finished chat, from the normalized event’s kept references', async () => {
  const socket = await setup();
  const text = withMentionContext('look at @quarterly-taxes please', [
    { name: 'quarterly-taxes', tabId: 'quarterly-taxes', paneIds: ['p-old'] },
  ]);
  await act(async () => {
    // A conversation that HAS history — a fresh one greets instead of drawing a log.
    socket.frame({
      t: 'session',
      mode: 'chat',
      hasMessages: true,
      turnRunning: false,
      session: { current_sid: 'session', writer: 'runner', view_mode: 'chat', assistant: 'claude' },
    });
    // What actually reaches the pane: the NORMALIZED event — block stripped,
    // references kept as `mentions` (shared/chat-events `forDisplay`).
    const events = normalizeTranscriptLine({
      type: 'user',
      uuid: 'u1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: text },
    });
    expect(JSON.stringify(events)).not.toContain('muxpad-context');
    socket.frame({ t: 'events', events });
  });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  // EXACT and scoped: asked for the referenced tab id, not a name or a pane.
  expect(asked).toContain('/api/tabs/lookup?tabIds=quarterly-taxes');
  expect(asked.some((u) => u.startsWith('/api/tabs/lookup?q='))).toBe(false);
  const pills = [...host.querySelectorAll('.chat-mention-pill')].map((b) => b.textContent);
  expect(pills).toEqual([expect.stringContaining('quarterly-taxes')]);
});

it('a pick persisted across a reload resolves by its EXACT tab id, not its name', async () => {
  localStorage.setItem(
    'muxpad.chatPicks.pane-here',
    JSON.stringify([{ tabId: 'quarterly-taxes', name: 'quarterly-taxes', start: 0 }]),
  );
  localStorage.setItem('muxpad.chatDraft.pane-here', '@quarterly-taxes ');
  await setup();
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  expect(asked).toContain('/api/tabs/lookup?tabIds=quarterly-taxes');
  expect(asked.some((u) => u.startsWith('/api/tabs/lookup?q='))).toBe(false);
});

it('an inbound message from a FINISHED chat is attributed to it', async () => {
  // Mentions this chat, so the pane loads its corpus — the sender lookup
  // rides on knowing which tab this pane is (a corpus fact).
  const brief = 'please file the quarterly return, @here';
  SENDERS = [{ key: inboundTextKey(brief), at: 1, from_tab_id: 'quarterly-taxes' }];
  const socket = await setup();
  await history(socket, [brief]);
  // Two hops more than a mention: the senders list lands, THEN its ids go out.
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  expect(asked).toContain('/api/tabs/lookup?tabIds=quarterly-taxes');
  expect(host.textContent).toContain('quarterly-taxes');
});

it('a report marker naming only a PANE resolves to the finished chat behind it', async () => {
  const socket = await setup();
  await history(socket, [
    renderReportMarker({ id: 'd1', from: 'some old name', pane: 'p-old' }, 'filed it'),
  ]);
  expect(asked).toContain('/api/tabs/lookup?paneIds=p-old');
  expect(host.textContent).toContain('quarterly-taxes');
});

it('a FINISHED current chat is still left out of its own picker', async () => {
  // This chat is finished: not in the live corpus, so `myChat` is absent —
  // and the lookup answers with it, both for the name and for its own pane.
  LIVE = { workspaces: [{ id: 'w1', slug: 'w1', name: 'Home', tabs: [row('other', 'p-other')] }] };
  EXTRA_OLD = [row('here', 'pane-here', { name: 'quarterly-mine', done: true })];
  await setup();
  await type('@quart');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(rows()).toEqual([expect.stringContaining('quarterly-taxes')]);
});

it('a directed card for a finished chat shows its CURRENT chip, not the send-time snapshot', async () => {
  localStorage.setItem(
    'muxpad.directed.pane-here',
    JSON.stringify([
      {
        id: 'd1',
        at: Date.now(),
        tabId: 'quarterly-taxes',
        tabSlug: 'quarterly-taxes',
        workspaceSlug: 'w2',
        body: 'file it',
        chip: { name: 'snapshot-name' },
      },
    ]),
  );
  const socket = await setup();
  await history(socket, ['hello']);
  expect(asked).toContain('/api/tabs/lookup?tabIds=quarterly-taxes');
  expect(host.textContent).toContain('quarterly-taxes');
  expect(host.textContent).not.toContain('snapshot-name');
});

it('an OLDER message with only a plain @name still chips its finished chat (bounded name fallback)', async () => {
  const socket = await setup();
  await history(socket, ['what did @quarterly-taxes decide?']);
  expect(asked).toContain('/api/tabs/lookup?q=quarterly-taxes');
  const pills = [...host.querySelectorAll('.chat-mention-pill')].map((b) => b.textContent);
  expect(pills).toEqual([expect.stringContaining('quarterly-taxes')]);
});

it('a LIVE chat sharing a first word does not suppress the archived one’s fallback', async () => {
  LIVE = {
    workspaces: [
      {
        id: 'w1',
        slug: 'w1',
        name: 'Home',
        tabs: [row('here', 'pane-here'), row('quarterly-plan', 'pane-plan')],
      },
    ],
  };
  const socket = await setup();
  await history(socket, ['compare @quarterly-plan with @quarterly-taxes']);
  expect(asked).toContain('/api/tabs/lookup?q=quarterly-taxes');
  // The live one, named in full, costs no query.
  expect(asked).not.toContain('/api/tabs/lookup?q=quarterly-plan');
  const pills = [...host.querySelectorAll('.chat-mention-pill')].map((b) => b.textContent);
  expect(pills).toEqual([
    expect.stringContaining('quarterly-plan'),
    expect.stringContaining('quarterly-taxes'),
  ]);
});
