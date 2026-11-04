import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { decodeLink } from './link-protocol.js';
import { LinkServer, linkUpgradeKind } from './link-server.js';

/** A WebSocket stand-in: readyState OPEN, records sends, can fire events. */
class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.readyState = 3;
    this.emit('close');
  }
}

const build = () => {
  const ptyd = new FakeWs();
  const tails: Array<{
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    loadOlder: ReturnType<typeof vi.fn>;
    sink: unknown;
  }> = [];
  const srv = new LinkServer({
    connectPtyd: () => ptyd as never,
    makeTail: (_sid, _a, sink) => {
      const t = { start: vi.fn(), close: vi.fn(), loadOlder: vi.fn(), sink };
      tails.push(t);
      return t as never;
    },
    log: () => {},
  });
  const link = new FakeWs();
  srv.attachLink(link as never);
  const up = () => link.sent.map((s) => decodeLink(s));
  return { srv, link, ptyd, tails, up };
};

describe('routing an upgrade', () => {
  it('knows the link from a runner, and rejects anything else', () => {
    expect(linkUpgradeKind('/link')).toEqual({ kind: 'link' });
    expect(linkUpgradeKind('/ws/agent-runner/01ABC')).toEqual({ kind: 'runner', paneId: '01ABC' });
    for (const p of [
      '/',
      '/control',
      '/pty/x',
      '/ws/agent-runner/',
      '/ws/agent-runner/a/b',
      '/link/x',
    ]) {
      expect(linkUpgradeKind(p), p).toBe(null);
    }
  });
});

describe('the ptyd channel is a passthrough', () => {
  it('forwards both directions verbatim, so ptyd never learns of a network', () => {
    const h = build();
    h.link.emit('message', JSON.stringify({ ch: 'ptyd', payload: '{"t":"req","id":1}' }));
    expect(h.ptyd.sent).toEqual(['{"t":"req","id":1}']);
    h.ptyd.emit('message', Buffer.from('{"t":"res","id":1}'));
    expect(h.up()).toContainEqual({ ch: 'ptyd', payload: '{"t":"res","id":1}' });
  });
});

describe('the runner channel', () => {
  it('announces an attach, relays frames up, and announces detach', () => {
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    expect(h.up()).toContainEqual({ ch: 'runner', op: 'attached', paneId: 'p1' });
    r.emit('message', Buffer.from(JSON.stringify({ t: 'turn-start' })));
    expect(h.up()).toContainEqual({
      ch: 'runner',
      op: 'frame',
      paneId: 'p1',
      frame: { t: 'turn-start' },
    });
    r.close();
    expect(h.up()).toContainEqual({ ch: 'runner', op: 'detached', paneId: 'p1' });
  });

  it('writes a server send down to the right runner only', () => {
    const h = build();
    const a = new FakeWs();
    const b = new FakeWs();
    h.srv.attachRunner('pa', a as never);
    h.srv.attachRunner('pb', b as never);
    h.link.emit(
      'message',
      JSON.stringify({ ch: 'runner', op: 'frame', paneId: 'pa', frame: { t: 'send', text: 'hi' } }),
    );
    expect(a.sent).toEqual([JSON.stringify({ t: 'send', text: 'hi' })]);
    expect(b.sent).toEqual([]);
  });

  it('NEWEST WINS, closing the old one 4001', () => {
    // A respawn can connect before the old socket's close fires; two runners
    // trading the registration would strobe the chat's status forever.
    const h = build();
    const old = new FakeWs();
    const next = new FakeWs();
    h.srv.attachRunner('p1', old as never);
    h.srv.attachRunner('p1', next as never);
    expect(old.closedWith?.code).toBe(4001);
    expect(h.srv.stats().runners).toBe(1);
  });

  it('a DISPLACED runner closing does not report a detach', () => {
    // Its successor is live; a detach would deregister the wrong thing.
    const h = build();
    const old = new FakeWs();
    h.srv.attachRunner('p1', old as never);
    h.srv.attachRunner('p1', new FakeWs() as never);
    const detaches = h.up().filter((m) => m && 'op' in m && m.op === 'detached');
    expect(detaches).toEqual([]);
  });

  it('a malformed frame is dropped, not relayed', () => {
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    r.emit('message', Buffer.from('not json'));
    expect(h.up().filter((m) => m && 'op' in m && m.op === 'frame')).toEqual([]);
  });

  it('re-announces every runner when the server reconnects', () => {
    const h = build();
    h.srv.attachRunner('p1', new FakeWs() as never);
    const link2 = new FakeWs();
    h.srv.attachLink(link2 as never);
    expect(link2.sent.map((s) => decodeLink(s))).toContainEqual({
      ch: 'runner',
      op: 'attached',
      paneId: 'p1',
    });
  });
});

/**
 * ── THE SID COMES FROM THE RUNNER'S OWN HELLO ────────────────────────────
 * The only place a fresh chat's session id exists before anything is written,
 * and the server cannot supply it: every path that records a sid (register,
 * /hook, hello) travels host→server.
 */
describe('learning the session id', () => {
  it('snoops hello, so a transcript subscribe can resolve the pane', () => {
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    // Before the hello there is nothing to tail.
    h.link.emit('message', JSON.stringify({ ch: 'transcript', op: 'subscribe', paneId: 'p1' }));
    expect(h.up()).toContainEqual({
      ch: 'transcript',
      op: 'unavailable',
      paneId: 'p1',
      reason: 'this machine is not running that chat',
    });
    r.emit('message', Buffer.from(JSON.stringify({ t: 'hello', sid: 's-1', backend: 'claude' })));
    h.link.emit('message', JSON.stringify({ ch: 'transcript', op: 'subscribe', paneId: 'p1' }));
    expect(h.tails).toHaveLength(1);
    expect(h.tails[0]?.start).toHaveBeenCalled();
  });

  it('a hello with a NEW sid re-tails, or the chat shows the old conversation', () => {
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    r.emit('message', Buffer.from(JSON.stringify({ t: 'hello', sid: 's-1' })));
    h.link.emit('message', JSON.stringify({ ch: 'transcript', op: 'subscribe', paneId: 'p1' }));
    expect(h.tails).toHaveLength(1);
    r.emit('message', Buffer.from(JSON.stringify({ t: 'hello', sid: 's-2' })));
    expect(h.tails).toHaveLength(2); // re-subscribed onto the new session
    expect(h.tails[0]?.close).toHaveBeenCalled();
  });
});

describe('the transcript channel', () => {
  it('pushes the tail’s events and title up', () => {
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    r.emit('message', Buffer.from(JSON.stringify({ t: 'hello', sid: 's-1' })));
    h.link.emit('message', JSON.stringify({ ch: 'transcript', op: 'subscribe', paneId: 'p1' }));
    const sink = h.tails[0]?.sink as {
      onEvents: (e: unknown[], p: string) => void;
      onTitle: (t: string) => void;
    };
    sink.onEvents([{ id: 'e1' }], 'history');
    sink.onTitle('T');
    expect(h.up()).toContainEqual({
      ch: 'transcript',
      op: 'events',
      paneId: 'p1',
      phase: 'history',
      events: [{ id: 'e1' }],
    });
    expect(h.up()).toContainEqual({ ch: 'transcript', op: 'title', paneId: 'p1', title: 'T' });
  });

  it('drops every subscription when the link closes', () => {
    // They belonged to a server that is no longer listening; it re-subscribes
    // for whatever is still being viewed.
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    r.emit('message', Buffer.from(JSON.stringify({ t: 'hello', sid: 's-1' })));
    h.link.emit('message', JSON.stringify({ ch: 'transcript', op: 'subscribe', paneId: 'p1' }));
    expect(h.srv.stats().subscriptions).toBe(1);
    h.link.close();
    expect(h.srv.stats().subscriptions).toBe(0);
  });
});

/**
 * ── A RUNNER SAYS HELLO ONCE ─────────────────────────────────────────────
 * If the server restarts afterwards, the runner's socket to the HOST never
 * dropped, so it has no reason to send another. Without a replay the server
 * registers a runner it knows nothing about — no session id — and the chat
 * view spins on "Starting…" forever over a runner that is attached and
 * answering. That is precisely what happened.
 */
describe('reconnect replays the hello', () => {
  it('re-announces AND re-sends the hello to a new server', () => {
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    r.emit('message', Buffer.from(JSON.stringify({ t: 'hello', sid: 's-1', backend: 'claude' })));
    const link2 = new FakeWs();
    h.srv.attachLink(link2 as never);
    const msgs = link2.sent.map((s) => decodeLink(s));
    expect(msgs).toContainEqual({ ch: 'runner', op: 'attached', paneId: 'p1' });
    expect(msgs).toContainEqual({
      ch: 'runner',
      op: 'frame',
      paneId: 'p1',
      frame: { t: 'hello', sid: 's-1', backend: 'claude' },
    });
    // …and in that order, so the far side has a relay to receive it.
    const iAttach = msgs.findIndex((m) => m && 'op' in m && m.op === 'attached');
    const iHello = msgs.findIndex((m) => m && 'op' in m && m.op === 'frame');
    expect(iAttach).toBeLessThan(iHello);
  });

  it('forgets the hello when the runner goes, so a stale one is never replayed', () => {
    const h = build();
    const r = new FakeWs();
    h.srv.attachRunner('p1', r as never);
    r.emit('message', Buffer.from(JSON.stringify({ t: 'hello', sid: 's-1' })));
    r.close();
    const link2 = new FakeWs();
    h.srv.attachLink(link2 as never);
    expect(link2.sent.map((s) => decodeLink(s))).toEqual([]);
  });
});
