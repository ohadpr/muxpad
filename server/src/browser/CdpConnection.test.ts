import { describe, expect, it, vi } from 'vitest';
import { CDP_CALL_TIMEOUT_MS, CdpConnection } from './CdpConnection.js';

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
  onclose: (() => void) | null = null;
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

  it('delivers to EVERY listener, not just the last one registered', async () => {
    // A Map<event, handler> silently replaces. The near-miss this pins:
    // ScreencastSession listens for Page.frameNavigated to re-arm the stream and
    // the host listens for the same event to track the current URL. With one
    // slot the second listener disables re-arming, and the only symptom is a
    // frozen picture after a navigation.
    const { conn, socket } = await attached();
    const first = vi.fn();
    const second = vi.fn();
    conn.on('Page.frameNavigated', first);
    conn.on('Page.frameNavigated', second);
    socket.event('Page.frameNavigated', { frame: { url: 'https://x/' } });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
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

it('binds a handoff to page B while page A still exists', async () => {
  const { conn } = connection();
  await conn.connect();
  const socket = FakeSocket.last as FakeSocket;
  const attaching = conn.attachToPage('p2');
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  socket.reply(socket.sent[0]!.id as number, {
    targetInfos: [
      ...TARGETS.targetInfos,
      { targetId: 'p2', type: 'page', url: 'https://example.com/login' },
    ],
  });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  expect(socket.sent[1]).toMatchObject({ params: { targetId: 'p2' } });
  socket.reply(socket.sent[1]!.id as number, { sessionId: 'S2' });
  await expect(attaching).resolves.toMatchObject({ targetId: 'p2' });
});

/**
 * A reply that never comes.
 *
 * Every call here used to wait forever. Nothing watched the socket after the
 * handshake and no call had a deadline, so a browser that went away left the
 * connection looking healthy and every later call parked for good: no error, no
 * log, nothing to act on. The visible damage was two levels up — the host hung
 * inside its own shutdown before reaching `chrome.kill()`, orphaning a Chrome
 * that then squatted the debugging port, so the NEXT host attached to a dead
 * browser and served a viewer that scrolled nothing and typed nothing.
 */
describe('giving up', () => {
  function timed(callTimeoutMs = 50) {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ webSocketDebuggerUrl: BROWSER_WS }),
    })) as unknown as typeof fetch;
    const errors: Array<[string, string]> = [];
    const conn = new CdpConnection({
      endpoint: 'http://127.0.0.1:9410',
      fetchImpl,
      socketImpl: FakeSocket as unknown as typeof WebSocket,
      callTimeoutMs,
      onError: (where, err) => errors.push([where, err.message]),
    });
    return { conn, errors };
  }

  it('rejects a call that is never answered, and says which one', async () => {
    const { conn } = timed();
    await conn.connect();
    await expect(conn.send('Page.reload')).rejects.toThrow(/Page\.reload did not answer/);
  });

  it('does not reject a call that IS answered', async () => {
    const { conn } = timed();
    await conn.connect();
    const call = conn.send('Page.reload');
    FakeSocket.last?.reply(1, { ok: true });
    await expect(call).resolves.toMatchObject({ ok: true });
  });

  it('fails everything in flight when the socket closes under it', async () => {
    const { conn, errors } = timed(5_000);
    await conn.connect();
    const a = conn.send('Page.reload');
    const b = conn.send('Page.navigate');
    FakeSocket.last?.onclose?.();
    await expect(a).rejects.toThrow(/closed/);
    await expect(b).rejects.toThrow(/closed/);
    expect(errors).toEqual([['closed', 'CDP connection closed']]);
  });

  it('refuses to send on a socket it has given up on, rather than waiting again', async () => {
    const { conn } = timed(5_000);
    await conn.connect();
    FakeSocket.last?.onclose?.();
    await expect(conn.send('Page.reload')).rejects.toThrow(/not connected/);
  });

  it('is generous by default — a slow page is not a dead one', () => {
    expect(CDP_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
