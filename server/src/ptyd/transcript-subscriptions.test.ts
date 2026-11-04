import { describe, expect, it, vi } from 'vitest';
import { TranscriptSubscriptions } from './transcript-subscriptions.js';

const fakeTail = () => ({
  start: vi.fn(),
  close: vi.fn(),
  loadOlder: vi.fn(),
});

const harness = (
  resolve: (p: string) => { sid: string; assistant: string } | null = () => ({
    sid: 'sid-1',
    assistant: 'claude',
  }),
) => {
  const pushed: Record<string, unknown>[] = [];
  const tails: ReturnType<typeof fakeTail>[] = [];
  const subs = new TranscriptSubscriptions({
    resolveSid: resolve,
    makeTail: (_sid, _assistant, sink) => {
      const t = fakeTail();
      tails.push(t);
      // Expose the sink so a test can fire events as the real tail would.
      (t as unknown as { sink: unknown }).sink = sink;
      return t;
    },
    push: (e) => pushed.push(e),
  });
  return { subs, pushed, tails };
};

describe('a host tails its own chats', () => {
  it('resolves its OWN sid — the server sends only a pane id', () => {
    // The server cannot send a sid: current_sid is written only by register,
    // /hook and runner hello, all host→server, the direction that cannot
    // initiate. For a chat that only ever ran here the server has never seen
    // one.
    const h = harness();
    expect(h.subs.subscribe('pane-1')).toBe('sid-1');
    expect(h.tails[0]?.start).toHaveBeenCalled();
  });

  it('refuses a pane it is not running, and SAYS SO', () => {
    // The host-side half of the boundary: the server checks the pane belongs
    // to this node, the host independently refuses one it is not running.
    const h = harness(() => null);
    expect(h.subs.subscribe('not-mine')).toBe(null);
    expect(h.pushed).toEqual([
      {
        ch: 'transcript',
        op: 'unavailable',
        paneId: 'not-mine',
        reason: 'this machine is not running that chat',
      },
    ]);
    expect(h.tails).toHaveLength(0); // and does not tail anything
  });

  it('is IDEMPOTENT — a re-subscribe replaces, never stacks', () => {
    // A browser reopening the chat, or the control socket reconnecting and
    // the server re-subscribing, must not double every event into the chat.
    const h = harness();
    h.subs.subscribe('pane-1');
    h.subs.subscribe('pane-1');
    expect(h.subs.count()).toBe(1);
    expect(h.tails).toHaveLength(2);
    expect(h.tails[0]?.close).toHaveBeenCalled(); // the first was torn down
  });

  it('pushes rendered events with the pane id the server asked about', () => {
    const h = harness();
    h.subs.subscribe('pane-1');
    const sink = (
      h.tails[0] as unknown as { sink: { onEvents: (e: unknown[], p: string) => void } }
    ).sink;
    sink.onEvents([{ id: 'e1' }], 'history');
    expect(h.pushed).toEqual([
      {
        ch: 'transcript',
        op: 'events',
        paneId: 'pane-1',
        phase: 'history',
        events: [{ id: 'e1' }],
      },
    ]);
  });

  it('reports a title but does not pretend to own it', () => {
    // The server writes the DB; the host only says what it read, so
    // applyAiTitle stays the single writer.
    const h = harness();
    h.subs.subscribe('pane-1');
    const sink = (h.tails[0] as unknown as { sink: { onTitle: (t: string) => void } }).sink;
    sink.onTitle('A title');
    expect(h.pushed).toEqual([
      { ch: 'transcript', op: 'title', paneId: 'pane-1', title: 'A title' },
    ]);
  });

  it('stops tailing on unsubscribe, so a closed tab does not poll forever', () => {
    const h = harness();
    h.subs.subscribe('pane-1');
    h.subs.unsubscribe('pane-1');
    expect(h.tails[0]?.close).toHaveBeenCalled();
    expect(h.subs.count()).toBe(0);
  });

  it('unsubscribing something unknown is a no-op, not a throw', () => {
    const h = harness();
    expect(() => h.subs.unsubscribe('never-seen')).not.toThrow();
  });

  it('closeAll drops every tail — the server that owned them is gone', () => {
    const h = harness();
    h.subs.subscribe('a');
    h.subs.subscribe('b');
    expect(h.subs.count()).toBe(2);
    h.subs.closeAll();
    expect(h.subs.count()).toBe(0);
    for (const t of h.tails) expect(t.close).toHaveBeenCalled();
  });

  it('loadOlder reaches the tail that owns the cursor', () => {
    const h = harness();
    h.subs.subscribe('pane-1');
    h.subs.loadOlder('pane-1');
    expect(h.tails[0]?.loadOlder).toHaveBeenCalled();
  });

  it('loadOlder for an unsubscribed pane is a no-op', () => {
    const h = harness();
    expect(() => h.subs.loadOlder('nope')).not.toThrow();
  });
});
