import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxpadEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * GET /api/events — the SSE mirror of /ws/events. Exercised through the full
 * app (createTestApp) so the mount point is covered too. The stream never
 * ends on its own; each test pumps the body into a buffer, asserts on what
 * arrived, then cancels the reader.
 */

describe('events SSE route', () => {
  let test: TestApp;
  let bus: EventBus;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-events-'));
    bus = new EventBus();
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, events: bus });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !pred()) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Open the stream and pump its bytes into a live buffer. */
  async function openStream(path: string) {
    const res = await test.app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body stream');
    const decoder = new TextDecoder();
    const state = { buf: '' };
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        state.buf += decoder.decode(value, { stream: true });
      }
    })().catch(() => {
      /* cancelled */
    });
    return {
      state,
      /** All JSON payloads of `data:` lines received so far. */
      events(): MuxpadEvent[] {
        return state.buf
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5).trim()) as MuxpadEvent);
      },
      close: () => reader.cancel().catch(() => {}),
    };
  }

  it('handshakes with a comment, then mirrors bus events as data lines', async () => {
    const stream = await openStream('/api/events');
    // The `: connected` comment arrives only after the bus subscription is
    // registered — muxpad agent wait relies on this ordering.
    await waitUntil(() => stream.state.buf.includes(': connected'));
    expect(stream.state.buf).toContain(': connected');

    const turn: MuxpadEvent = {
      type: 'agent_turn',
      pane_id: 'p1',
      phase: 'start',
      sid: 'sid-1',
      backend: 'claude',
    };
    bus.emit(turn);
    bus.emit({ type: 'agent_session.updated', pane_id: 'p1' });
    await waitUntil(() => stream.events().length >= 2);

    expect(stream.events()[0]).toEqual(turn);
    expect(stream.events()[1]).toEqual({ type: 'agent_session.updated', pane_id: 'p1' });
    await stream.close();
  });

  it('?types= filters server-side', async () => {
    const stream = await openStream('/api/events?types=agent_turn,pane.removed');
    await waitUntil(() => stream.state.buf.includes(': connected'));

    bus.emit({ type: 'agent_session.updated', pane_id: 'px' });
    bus.emit({ type: 'workspace.removed', workspace_id: 'wx' });
    bus.emit({
      type: 'agent_turn',
      pane_id: 'p2',
      phase: 'done',
      sid: 'sid-2',
      backend: 'codex',
    });
    // The filtered-out events were emitted FIRST — if they were going to
    // arrive, they'd precede the agent_turn line we wait for.
    await waitUntil(() => stream.events().length >= 1);

    const got = stream.events();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'agent_turn', pane_id: 'p2', phase: 'done' });
    await stream.close();
  });

  it('unsubscribes from the bus when the client goes away', async () => {
    const stream = await openStream('/api/events');
    await waitUntil(() => stream.state.buf.includes(': connected'));
    await stream.close();
    // Give the abort a beat to propagate, then emit — nothing should throw,
    // and the buffer must not grow (the listener is gone).
    await new Promise((r) => setTimeout(r, 100));
    const before = stream.state.buf.length;
    bus.emit({ type: 'agent_session.updated', pane_id: 'p-late' });
    await new Promise((r) => setTimeout(r, 150));
    expect(stream.state.buf.length).toBe(before);
  });
});
