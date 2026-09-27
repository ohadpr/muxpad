import { describe, expect, it, vi } from 'vitest';
import { CdpConnection } from './CdpConnection.js';

/**
 * The connection, and the reason it attaches where it does.
 *
 * `/devtools/page/<id>` accepts exactly one client. Holding it locks out
 * DevTools, the Playwright MCP, and any second viewer — which would make a
 * muxpad-owned browser useless for the one thing it exists for, an agent and a
 * human on the same page at the same time. So: browser endpoint, flat sessions.
 */

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.closed = true;
  }

  /** Answer the Nth request with a result. */
  reply(id: number, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }

  fail(id: number, message: string) {
    this.onmessage?.({ data: JSON.stringify({ id, error: { message } }) });
  }

  event(method: string, params: unknown) {
    this.onmessage?.({ data: JSON.stringify({ method, params }) });
  }
}

const BROWSER_WS = 'ws://127.0.0.1:9410/devtools/browser/abc';

function connection() {
  const fetchImpl = vi.fn(async () => ({
    json: async () => ({ webSocketDebuggerUrl: BROWSER_WS }),
  })) as unknown as typeof fetch;
  const conn = new CdpConnection({
    endpoint: 'http://127.0.0.1:9410',
    fetchImpl,
    socketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  return { conn, fetchImpl };
}

const TARGETS = {
  targetInfos: [
    { targetId: 'dt', type: 'page', url: 'devtools://devtools/inspector.html' },
    { targetId: 'p1', type: 'page', url: 'https://example.com/' },
  ],
};

describe('connecting', () => {
  it('opens the BROWSER socket, never a per-page one', async () => {
    const { conn } = connection();
    await conn.connect();
    expect(FakeSocket.last?.url).toBe(BROWSER_WS);
    expect(FakeSocket.last?.url).not.toContain('/devtools/page/');
  });
});

describe('attaching', () => {
  it('takes a flat session on a real page target', async () => {
    const { conn } = connection();
    await conn.connect();
    const socket = FakeSocket.last as FakeSocket;

    const attaching = conn.attachToPage();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({ method: 'Target.getTargets' });
    // No sessionId on a browser-level call.
    expect(socket.sent[0]).not.toHaveProperty('sessionId');
    socket.reply(socket.sent[0]?.id as number, TARGETS);

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[1]).toMatchObject({
      method: 'Target.attachToTarget',
      params: { targetId: 'p1', flatten: true },
    });
    socket.reply(socket.sent[1]?.id as number, { sessionId: 'S1' });

    await expect(attaching).resolves.toMatchObject({ targetId: 'p1' });
  });

  it('skips devtools:// targets, or we stream a picture of the debugger', async () => {
    const { conn } = connection();
    await conn.connect();
    const socket = FakeSocket.last as FakeSocket;
    const attaching = conn.attachToPage();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(socket.sent[0]?.id as number, TARGETS);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((socket.sent[1]?.params as { targetId: string }).targetId).not.toBe('dt');
  });

  it('fails loudly when the browser has no page at all', async () => {
    const { conn } = connection();
    await conn.connect();
    const socket = FakeSocket.last as FakeSocket;
    const attaching = conn.attachToPage();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(socket.sent[0]?.id as number, { targetInfos: [] });
    await expect(attaching).rejects.toThrow(/no page target/i);
  });
});

describe('after attaching', () => {
  async function attached() {
    const { conn } = connection();
    await conn.connect();
    const socket = FakeSocket.last as FakeSocket;
    const attaching = conn.attachToPage();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(socket.sent[0]?.id as number, TARGETS);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.reply(socket.sent[1]?.id as number, { sessionId: 'S1' });
    await attaching;
    socket.sent.length = 0;
    return { conn, socket };
  }

  it('routes page calls through the flat session', async () => {
    const { conn, socket } = await attached();
    void conn.send('Page.enable');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({ method: 'Page.enable', sessionId: 'S1' });
  });

  it('rejects with the protocol message, not a generic failure', async () => {
    // "Screencast is already active" is load-bearing — ScreencastSession's
    // re-arm exists because of it. Losing the text loses the diagnosis.
    const { conn, socket } = await attached();
    const call = conn.send('Page.startScreencast');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.fail(socket.sent[0]?.id as number, 'Screencast is already active');
    await expect(call).rejects.toThrow(/already active/);
  });

  it('delivers events to their handler', async () => {
    const { conn, socket } = await attached();
    const seen = vi.fn();
    conn.on('Page.frameNavigated', seen);
    socket.event('Page.frameNavigated', { frame: { url: 'https://x/' } });
    expect(seen).toHaveBeenCalledWith({ frame: { url: 'https://x/' } });
  });

  it('ignores an event nothing is listening for, rather than throwing', async () => {
    const { conn, socket } = await attached();
    void conn;
    expect(() => socket.event('Network.requestWillBeSent', {})).not.toThrow();
  });

  it('rejects everything in flight when the socket closes', async () => {
    // Otherwise a browser that died mid-call leaves a promise that never
    // settles, and whatever was awaiting it hangs forever.
    const { conn, socket } = await attached();
    const call = conn.send('Page.enable');
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    conn.close();
    await expect(call).rejects.toThrow(/closed/i);
    expect(socket.closed).toBe(true);
  });
});
