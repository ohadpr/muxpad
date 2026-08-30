import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { PtydCache, decoratePane } from '../ptyd-cache.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

async function boot() {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const agents = new AgentSessionStore(db);
  const events = new EventBus();
  const ws = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  const cache = new PtydCache();
  // Mirror the production wiring in index.ts: the cache's single 'paneChange'
  // per status edge becomes ONE decorated pane.updated on the bus. Without it
  // these tests would silently pass on a server that emits nothing, and would
  // hide a double-emit if ws.ts also emitted by hand.
  cache.on('paneChange', (id: string) => {
    const p = panes.getById(id);
    if (p) events.emit({ type: 'pane.updated', tab_id: p.tab_id, pane: decoratePane(cache, p) });
  });
  attachWsServer({ http, db, ptyd: ptyd.client, cache, events });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { port, paneId: pane.id, panes, agents, events, cache };
}

/**
 * Open a socket with its frame collector attached BEFORE the open handshake
 * resolves — the server sends its hello in the upgrade callback, so a
 * listener attached after `open` can lose it to the same-tick race.
 */
async function openSock(url: string): Promise<{ sock: WebSocket; rx: Collector }> {
  const sock = new WebSocket(url);
  const rx = collector(sock);
  await new Promise<void>((resolve, reject) => {
    sock.once('open', () => resolve());
    sock.once('error', reject);
  });
  return { sock, rx };
}

type Collector = ReturnType<typeof collector>;

/** Collects parsed JSON frames; `next(pred)` resolves when a matching one lands. */
function collector(sock: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<{
    pred: (f: Record<string, unknown>) => boolean;
    resolve: (f: Record<string, unknown>) => void;
  }> = [];
  sock.on('message', (data) => {
    const f = JSON.parse(String(data)) as Record<string, unknown>;
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i] as (typeof waiters)[number];
      if (w.pred(f)) {
        waiters.splice(i, 1);
        w.resolve(f);
      }
    }
  });
  return {
    frames,
    next(
      pred: (f: Record<string, unknown>) => boolean,
      timeoutMs = 3000,
    ): Promise<Record<string, unknown>> {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(t);
            resolve(f);
          },
        });
      });
    },
  };
}

const SID = '11111111-2222-3333-4444-555555555555';

describe('agent-runner relay', () => {
  it('hello attaches the runner: session row, startup_cmd self-heal, event emitted', async () => {
    const { port, paneId, panes, agents, events } = await boot();
    const emitted: string[] = [];
    events.subscribe((e) => {
      if (e.type === 'agent_session.updated') emitted.push(e.pane_id);
    });
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(
      JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp/proj', pid: 1234, turnActive: false }),
    );
    await new Promise((r) => setTimeout(r, 150));

    const s = agents.getByPane(paneId);
    expect(s?.writer).toBe('sdk');
    expect(s?.view_mode).toBe('chat');
    expect(s?.current_sid).toBe(SID);
    expect(s?.cwd).toBe('/tmp/proj');
    expect(panes.getById(paneId)?.startup_cmd).toBe(`muxpad agent --resume ${SID}`);
    expect(emitted).toContain(paneId);
    runner.close();
  });

  it('relays chat sends to the runner and turn lifecycle back to chat clients', async () => {
    const { port, paneId } = await boot();
    const { sock: runner, rx: fromServer } = await openSock(
      `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`,
    );
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));

    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    chat.send(JSON.stringify({ t: 'send', text: 'hello agent' }));
    await fromChat.next((f) => f.t === 'send-ack');
    const sendFrame = await fromServer.next((f) => f.t === 'send');
    expect(sendFrame.text).toBe('hello agent');

    // Runner drives the turn; chat sees the lifecycle.
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await fromChat.next((f) => f.t === 'turn-start');
    runner.send(JSON.stringify({ t: 'stream', delta: 'Hi ' }));
    runner.send(JSON.stringify({ t: 'stream', delta: 'there' }));
    await fromChat.next((f) => f.t === 'stream' && f.delta === 'there');

    // A chat socket connecting mid-turn gets turnRunning + accumulated text.
    const { sock: chat2, rx: fromChat2 } = await openSock(
      `ws://127.0.0.1:${port}/ws/chat/${paneId}`,
    );
    const hello2 = await fromChat2.next((f) => f.t === 'session');
    expect(hello2.turnRunning).toBe(true);
    expect(hello2.streamText).toBe('Hi there');

    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    const done = await fromChat.next((f) => f.t === 'turn-done');
    expect(done.ok).toBe(true);
    await fromChat2.next((f) => f.t === 'turn-done');

    // Stop right after a send (turn over, but a send was relayed within the
    // recency window) RELAYS — the "send, then immediately Stop (oops)"
    // pattern must reach the runner so it can cancel the queued message;
    // turnActive alone lags a fresh send by a round trip.
    chat.send(JSON.stringify({ t: 'stop' }));
    await fromServer.next((f) => f.t === 'stop');

    runner.close();
    chat.close();
    chat2.close();
  });

  it('idle stop with no recent send resyncs only the requesting socket', async () => {
    const { port, paneId } = await boot();
    const { sock: runner, rx: fromServer } = await openSock(
      `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`,
    );
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    const { sock: chat2, rx: fromChat2 } = await openSock(
      `ws://127.0.0.1:${port}/ws/chat/${paneId}`,
    );
    await fromChat.next((f) => f.t === 'session');
    await fromChat2.next((f) => f.t === 'session');
    const chat2FramesBefore = fromChat2.frames.length;
    chat.send(JSON.stringify({ t: 'stop' }));
    await fromChat.next((f) => f.t === 'turn-done');
    await new Promise((r) => setTimeout(r, 150));
    // Not relayed (no turn, no recent send), and the OTHER client saw
    // nothing (a broadcast here once wiped its optimistic send state).
    expect(fromServer.frames.some((f) => f.t === 'stop')).toBe(false);
    expect(fromChat2.frames.length).toBe(chat2FramesBefore);
    runner.close();
    chat.close();
    chat2.close();
  });

  it('validates and merges status frames; hello carries the merged snapshot', async () => {
    const { port, paneId } = await boot();
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    // A truly invalid status (no model) must be dropped, not cached or bcast.
    runner.send(JSON.stringify({ t: 'status', context: { pct: 1, tokens: 1, max: 2 } }));
    await new Promise((r) => setTimeout(r, 150));
    expect(fromChat.frames.some((f) => f.t === 'status')).toBe(false);

    // A context-LESS status (Codex/Cursor have no context window) is VALID now
    // and flows through carrying just the model.
    runner.send(JSON.stringify({ t: 'status', model: 'ctxless-model' }));
    const stCtxless = await fromChat.next((f) => f.t === 'status');
    expect((stCtxless as { model: string }).model).toBe('ctxless-model');
    expect((stCtxless as { context?: unknown }).context).toBeUndefined();

    // Valid status with models flows through.
    runner.send(
      JSON.stringify({
        t: 'status',
        model: 'claude-x',
        context: { pct: 12, tokens: 24000, max: 200000 },
        models: [{ value: 'x', displayName: 'X' }],
      }),
    );
    const st1 = await fromChat.next((f) => f.t === 'status' && f.model === 'claude-x');
    expect((st1.models as unknown[]).length).toBe(1);

    // A later frame WITHOUT models keeps the last known list (merged).
    runner.send(
      JSON.stringify({
        t: 'status',
        model: 'claude-x',
        context: { pct: 13, tokens: 26000, max: 200000 },
      }),
    );
    const st2 = await fromChat.next(
      (f) => f.t === 'status' && (f.context as { pct?: number } | undefined)?.pct === 13,
    );
    expect((st2.models as unknown[]).length).toBe(1);

    // A fresh chat socket's hello includes the merged snapshot.
    const { sock: chat2, rx: fromChat2 } = await openSock(
      `ws://127.0.0.1:${port}/ws/chat/${paneId}`,
    );
    const hello2 = await fromChat2.next((f) => f.t === 'session');
    const helloStatus = hello2.status as { context: { pct: number }; models: unknown[] };
    expect(helloStatus.context.pct).toBe(13);
    expect(helloStatus.models.length).toBe(1);

    runner.close();
    chat.close();
    chat2.close();
  });

  it('emits agent_turn lifecycle on the global bus and fans it out to /ws/events', async () => {
    const { port, paneId } = await boot();
    // A supervisor holds ONE /ws/events socket, not a chat socket per pane —
    // turn lifecycle must reach it (spec A4). Subscribe before the runner
    // acts so every phase is observable.
    const { sock: evSock, rx: fromEvents } = await openSock(`ws://127.0.0.1:${port}/ws/events`);
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(
      JSON.stringify({
        t: 'hello',
        sid: SID,
        cwd: '/tmp',
        pid: 1,
        turnActive: false,
        backend: 'codex',
      }),
    );

    runner.send(JSON.stringify({ t: 'turn-start' }));
    const start = await fromEvents.next((f) => f.type === 'agent_turn' && f.phase === 'start');
    expect(start).toMatchObject({
      type: 'agent_turn',
      pane_id: paneId,
      phase: 'start',
      sid: SID,
      backend: 'codex',
    });

    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    const done = await fromEvents.next((f) => f.type === 'agent_turn' && f.phase === 'done');
    expect(done).toMatchObject({ pane_id: paneId, sid: SID, backend: 'codex' });

    // A dying runner's fatal reaches the bus too — a supervisor must learn
    // about dead workers, not just finished ones.
    runner.send(JSON.stringify({ t: 'fatal', error: 'boom' }));
    const fatal = await fromEvents.next((f) => f.type === 'agent_turn' && f.phase === 'fatal');
    expect(fatal).toMatchObject({ pane_id: paneId, phase: 'fatal' });

    runner.close();
    evSock.close();
  });

  it('a question BLOCKS the pane in the nav, and answering unblocks it (D5)', async () => {
    // "Needs input" had no representation in the nav at all: the question frame
    // reached chat sockets and a push and touched nothing else, so a chat
    // parked on ask_user read as plain idle in the sidebar.
    const { port, paneId, cache, events } = await boot();
    const seen: string[] = [];
    events.subscribe((e) => {
      if (e.type === 'pane.updated' && e.pane.id === paneId) seen.push(e.pane.status ?? 'none');
    });
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.getStatus(paneId, false)).toBe('working');

    runner.send(
      JSON.stringify({
        t: 'question',
        qid: 'q1',
        questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [] }],
      }),
    );
    await new Promise((r) => setTimeout(r, 80));
    // Blocked outranks working — the pane wants you NOW.
    expect(cache.getStatus(paneId, false)).toBe('blocked');
    // Exactly ONE pane.updated for the edge — the cache's paneChange is the
    // single emitter. ws.ts used to also emit by hand, doubling every edge.
    expect(seen.filter((s) => s === 'blocked')).toHaveLength(1);

    runner.send(JSON.stringify({ t: 'question-done', qid: 'q1' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.getStatus(paneId, false)).toBe('working');

    // A turn that ends with a question still open must not leave it stuck.
    runner.send(
      JSON.stringify({
        t: 'question',
        qid: 'q2',
        questions: [{ question: 'Again?', header: 'Pick', multiSelect: false, options: [] }],
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.getStatus(paneId, false)).toBe('blocked');
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.getStatus(paneId, false)).not.toBe('blocked');

    runner.close();
  });

  it('a runner-owned pane takes its status from the REGISTRY, not pty output (D4)', async () => {
    const { port, paneId, cache } = await boot();
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    await new Promise((r) => setTimeout(r, 80));
    // Hello registered the pane as runner-owned; an idle runner reads idle even
    // though its own terminal log is chattering.
    expect(cache.getStatus(paneId, false)).toBe('idle');
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.getStatus(paneId, false)).toBe('working');
    // The runner leaves → the pane goes back to pty-heuristic territory.
    runner.terminate();
    await new Promise((r) => setTimeout(r, 120));
    expect(cache.getStatus(paneId, false)).toBe('idle');
  });

  it('the subagent roster is DURABLE: it survives turn-done and keeps the pane busy', async () => {
    // D3, the reported symptom verbatim: a background subagent vanished from
    // the sidebar and the in-pane list the instant the parent turn ended.
    const { port, paneId, cache } = await boot();
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    // A turn launches a background subagent, then ends.
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(
      JSON.stringify({
        t: 'subagent',
        progress: { toolUseId: 'tu_1', steps: 0, label: 'audit the pipeline' },
      }),
    );
    await fromChat.next((f) => f.t === 'subagent');
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await fromChat.next((f) => f.t === 'turn-done');
    await new Promise((r) => setTimeout(r, 100));

    // The turn is over; the subagent is not. The pane is still WORKING, with
    // no decay window involved.
    expect(cache.getBusy(paneId)).toBe(true);
    expect(cache.getSubagentCount(paneId)).toBe(1);

    // A chat socket that connects AFTER turn-done still gets the roster — this
    // is the path that used to hand back an empty list.
    const { sock: chat2, rx: fromChat2 } = await openSock(
      `ws://127.0.0.1:${port}/ws/chat/${paneId}`,
    );
    const hello2 = await fromChat2.next((f) => f.t === 'session');
    const roster = hello2.subagents as Array<{ toolUseId: string; label?: string }>;
    expect(roster.map((s) => s.toolUseId)).toEqual(['tu_1']);
    expect(roster[0]?.label).toBe('audit the pipeline');

    // Only an explicit finish retires it.
    runner.send(
      JSON.stringify({ t: 'subagent', progress: { toolUseId: 'tu_1', steps: 9, done: true } }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(cache.getSubagentCount(paneId)).toBe(0);
    expect(cache.getBusy(paneId)).toBe(false);

    runner.close();
    chat.close();
    chat2.close();
  });

  it('a roster that appears mid-socket re-pushes the session frame (hello fingerprint)', async () => {
    // D3's fourth stacked failure: the hello signature omitted subagents, so
    // the 10s sessionPoll could never push a later snapshot to an ALREADY-OPEN
    // socket. Only a brand-new socket ever got one — and by then the server
    // held nothing.
    const { port, paneId } = await boot();
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    const first = await fromChat.next((f) => f.t === 'session');
    expect(first.subagents).toBeUndefined();

    // The runner announces a subagent; the SIGNATURE changed, so the next poll
    // (forced here by a session-shape re-sync) re-pushes the frame.
    runner.send(
      JSON.stringify({ t: 'subagent', progress: { toolUseId: 'tu_a', steps: 1, label: 'a' } }),
    );
    await fromChat.next((f) => f.t === 'subagent');
    // Nudge syncSession without waiting the full 10s: any agent_session.updated
    // for this pane re-runs it, and a turn-start emits one via setStatus.
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp2', pid: 1, turnActive: false }));
    const second = await fromChat.next((f) => f.t === 'session' && f !== first);
    expect((second.subagents as Array<{ toolUseId: string }>).map((s) => s.toolUseId)).toEqual([
      'tu_a',
    ]);

    runner.close();
    chat.close();
  });

  it('a runner death clears the roster; a reconnect re-announces it', async () => {
    const { port, paneId, cache } = await boot();
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    runner.send(
      JSON.stringify({ t: 'subagent', progress: { toolUseId: 'tu_x', steps: 3, label: 'x' } }),
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(cache.getSubagentCount(paneId)).toBe(1);

    // The runner's subagents die with the process — nothing else will ever
    // report them done, so this is the one other retirement edge.
    runner.terminate();
    await new Promise((r) => setTimeout(r, 150));
    expect(cache.getSubagentCount(paneId)).toBe(0);
    expect(cache.getBusy(paneId)).toBe(false);

    // The runner comes back and re-announces its live roster (onConnected).
    const { sock: again } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    again.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 2, turnActive: false }));
    again.send(
      JSON.stringify({ t: 'subagent', progress: { toolUseId: 'tu_x', steps: 4, label: 'x' } }),
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(cache.getSubagentCount(paneId)).toBe(1);
    again.close();
  });

  it('agent_turn start/done pairs stay BALANCED across reconnect and teardown', async () => {
    // D8: the hello mid-turn branch restored turnActive/agentBusy/chat state
    // but never emitted `start`, and teardown broadcast turn-done to chat
    // sockets without emitting `done`. So a supervisor (or `muxpad agent wait`)
    // saw a start with no done on a SIGKILLed runner, and a done with no start
    // after a server restart mid-turn.
    const { port, paneId } = await boot();
    const { sock: evSock, rx: fromEvents } = await openSock(`ws://127.0.0.1:${port}/ws/events`);

    // 1) A runner that (re)hellos MID-TURN is an observable turn START.
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: true }));
    const start = await fromEvents.next((f) => f.type === 'agent_turn' && f.phase === 'start');
    expect(start).toMatchObject({ pane_id: paneId, phase: 'start', sid: SID });

    // 2) …and its death closes that turn on the bus, not just on chat.
    runner.terminate();
    const done = await fromEvents.next((f) => f.type === 'agent_turn' && f.phase === 'done');
    expect(done).toMatchObject({ pane_id: paneId, phase: 'done', sid: SID });

    // Exactly one of each — teardown must not double-fire.
    const phases = fromEvents.frames
      .filter((f) => f.type === 'agent_turn')
      .map((f) => f.phase as string);
    expect(phases).toEqual(['start', 'done']);

    evSock.close();
  });

  it('answers set-model/slash with a notice frame when no runner is connected', async () => {
    const { port, paneId } = await boot();
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');
    chat.send(JSON.stringify({ t: 'set-model', model: 'sonnet' }));
    // `notice`, NOT `error` — the client's error handler resets send state,
    // which is wrong for a failed menu action during a streaming turn.
    const n1 = await fromChat.next((f) => f.t === 'notice');
    expect(String(n1.message)).toMatch(/reconnecting/);
    chat.send(JSON.stringify({ t: 'slash', cmd: 'compact' }));
    await fromChat.next(
      (f) => f.t === 'notice' && fromChat.frames.filter((x) => x.t === 'notice').length >= 2,
    );
    expect(fromChat.frames.some((f) => f.t === 'error')).toBe(false);
    chat.close();
  });

  it('runner disconnect mid-turn fails the turn and releases the writer', async () => {
    const { port, paneId, agents } = await boot();
    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    runner.send(JSON.stringify({ t: 'turn-start' }));
    await fromChat.next((f) => f.t === 'turn-start');
    runner.close();

    const done = await fromChat.next((f) => f.t === 'turn-done');
    expect(done.ok).toBe(false);
    expect(String(done.error)).toContain('disconnected');
    await new Promise((r) => setTimeout(r, 100));
    expect(agents.getByPane(paneId)?.writer).toBe('none');
    chat.close();
  });

  it('a respawned runner replaces the old one without being torn down by it', async () => {
    const { port, paneId, agents } = await boot();
    const { sock: first } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    first.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    await new Promise((r) => setTimeout(r, 100));

    const { sock: second, rx: fromServer } = await openSock(
      `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`,
    );
    second.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 2, turnActive: false }));
    await new Promise((r) => setTimeout(r, 200));
    // The first socket was terminated server-side; its close must NOT have
    // detached the second runner's registration.
    expect(agents.getByPane(paneId)?.writer).toBe('sdk');

    // The second runner still receives relayed sends.
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');
    chat.send(JSON.stringify({ t: 'send', text: 'ping' }));
    const frame = await fromServer.next((f) => f.t === 'send');
    expect(frame.text).toBe('ping');

    second.close();
    chat.close();
  });

  it('closes a displaced runner with 4001 and mutes its late frames', async () => {
    const { port, paneId } = await boot();
    const { sock: first } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    first.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    await new Promise((r) => setTimeout(r, 100));

    const closeCode = new Promise<number>((resolve) => {
      first.once('close', (code) => resolve(code));
    });

    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    // The registration swap happens at SECOND's upgrade, so once its open
    // resolves the first socket is already displaced server-side. A frame
    // the stale socket manages to flush during its close handshake must not
    // reach chat clients (status strobing / busy flips) — send with an
    // error-swallowing callback since the socket may already be closing.
    const { sock: second } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    first.send(
      JSON.stringify({
        t: 'status',
        model: 'stale-model',
        context: { pct: 99, tokens: 1, max: 2 },
      }),
      () => {},
    );
    second.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 2, turnActive: false }));
    second.send(
      JSON.stringify({ t: 'status', model: 'live-model', context: { pct: 5, tokens: 1, max: 2 } }),
    );

    // The displaced runner is told to EXIT (4001), not merely dropped — a
    // live orphan that reconnected would steal the pane back forever.
    expect(await closeCode).toBe(4001);

    const status = await fromChat.next((f) => f.t === 'status');
    expect(status.model).toBe('live-model');
    expect(fromChat.frames.filter((f) => f.t === 'status')).toHaveLength(1);

    second.close();
    chat.close();
  });

  it('queues a chat send while a runner-owned pane is between connections, then drains on reconnect', async () => {
    const { port, paneId } = await boot();
    const { sock: runner, rx: fromRunner } = await openSock(
      `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`,
    );
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    await new Promise((r) => setTimeout(r, 150));
    // Runner drops (server restart / ws blip). Its SDK process is still alive in
    // the pty; a send must NOT be dropped nor fall through to a second writer —
    // it's parked in the server-owned queue and delivered when the runner is back.
    runner.close();
    await new Promise((r) => setTimeout(r, 100));

    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');
    chat.send(JSON.stringify({ t: 'send', text: 'while gone' }));
    // No error — it's queued (client is told, and the pending bubble broadcasts).
    const queued = await fromChat.next((f) => f.t === 'queued');
    expect(queued.text).toBe('while gone');
    const q = await fromChat.next((f) => f.t === 'queue');
    expect((q.items as { text: string }[]).map((i) => i.text)).toEqual(['while gone']);
    expect(fromChat.frames.some((f) => f.t === 'error')).toBe(false);

    // Runner reconnects → the queue drains into it, then the pending bubble clears.
    const { sock: runner2, rx: fromRunner2 } = await openSock(
      `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`,
    );
    runner2.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 2, turnActive: false }));
    const delivered = await fromRunner2.next((f) => f.t === 'send');
    expect(delivered.text).toBe('while gone');
    const emptied = await fromChat.next(
      (f) => f.t === 'queue' && (f.items as unknown[]).length === 0,
    );
    expect((emptied.items as unknown[]).length).toBe(0);
    void fromRunner;
    runner2.close();
    chat.close();
  });

  it('queues sends while the agent is busy and drains them one turn at a time', async () => {
    const { port, paneId } = await boot();
    const { sock: runner, rx: fromRunner } = await openSock(
      `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`,
    );
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    // First send runs immediately.
    chat.send(JSON.stringify({ t: 'send', text: 'one' }));
    const first = await fromRunner.next((f) => f.t === 'send');
    expect(first.text).toBe('one');
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await fromChat.next((f) => f.t === 'turn-start');

    // Two more arrive while busy → queued (not relayed yet), in order.
    chat.send(JSON.stringify({ t: 'send', text: 'two' }));
    chat.send(JSON.stringify({ t: 'send', text: 'three' }));
    await fromChat.next(
      (f) =>
        f.t === 'queue' &&
        (f.items as { text: string }[]).map((i) => i.text).join() === 'two,three',
    );
    // Nothing but the first send has reached the runner.
    expect(fromRunner.frames.filter((f) => f.t === 'send')).toHaveLength(1);

    // Close the browser — the server must keep draining with no client open.
    chat.close();
    await new Promise((r) => setTimeout(r, 50));

    // Turn 1 ends → 'two' drains.
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    const second = await fromRunner.next((f) => f.t === 'send' && f.text === 'two');
    expect(second.text).toBe('two');
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    // Turn 2 ends → 'three' drains.
    const third = await fromRunner.next((f) => f.t === 'send' && f.text === 'three');
    expect(third.text).toBe('three');
    runner.send(JSON.stringify({ t: 'turn-start' }));
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));

    // Queue empty; a reconnecting client sees no pending bubbles.
    await new Promise((r) => setTimeout(r, 50));
    const { sock: chat2, rx: fromChat2 } = await openSock(
      `ws://127.0.0.1:${port}/ws/chat/${paneId}`,
    );
    const hello = await fromChat2.next((f) => f.t === 'session');
    expect((hello.queue as unknown[]).length).toBe(0);
    runner.close();
    chat2.close();
  });

  it('cancels a queued message before it runs', async () => {
    const { port, paneId } = await boot();
    const { sock: runner, rx: fromRunner } = await openSock(
      `ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`,
    );
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: false }));
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    chat.send(JSON.stringify({ t: 'send', text: 'one' }));
    await fromRunner.next((f) => f.t === 'send');
    runner.send(JSON.stringify({ t: 'turn-start' }));
    await fromChat.next((f) => f.t === 'turn-start');

    chat.send(JSON.stringify({ t: 'send', text: 'cancel me' }));
    const q = await fromChat.next((f) => f.t === 'queue' && (f.items as unknown[]).length === 1);
    const id = (q.items as { id: string }[])[0]?.id;
    chat.send(JSON.stringify({ t: 'queue-cancel', id }));
    await fromChat.next((f) => f.t === 'queue' && (f.items as unknown[]).length === 0);

    // Turn ends — the cancelled message must NOT drain into the runner.
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(fromRunner.frames.filter((f) => f.t === 'send')).toHaveLength(1);
    runner.close();
    chat.close();
  });

  it('re-broadcasts turn-start when a runner reconnects mid-turn', async () => {
    const { port, paneId } = await boot();
    const { sock: chat, rx: fromChat } = await openSock(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    await fromChat.next((f) => f.t === 'session');

    const { sock: runner } = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive: true }));
    // The already-open chat client learns the turn is running from the
    // re-broadcast, not from a session-shape change.
    await fromChat.next((f) => f.t === 'turn-start');
    runner.close();
    chat.close();
  });

  it('rejects a runner for a pane that does not exist', async () => {
    const { port } = await boot();
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-runner/nope`);
    const result = await new Promise<'closed' | 'open'>((resolve) => {
      sock.once('open', () => resolve('open'));
      sock.once('close', () => resolve('closed'));
      sock.once('error', () => resolve('closed'));
    });
    expect(result).toBe('closed');
  });
});

// agent_sessions.pane_id has a FK to panes — mint real rows for store tests.
function storeFixture() {
  const db = openDb(':memory:');
  const agents = new AgentSessionStore(db);
  const panes = new PaneStore(db);
  const tabs = new TabStore(db);
  const workspaces = new WorkspaceStore(db);
  const w = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'x', workspace_id: w.id });
  const mkPane = () => panes.create({ tab_id: tab.id, shell: '/bin/zsh', cwd: '/tmp' }).id;
  return { agents, mkPane };
}

describe('AgentSessionStore runner methods', () => {
  it('attachRunner upserts and detachRunner releases only an sdk writer', () => {
    const { agents, mkPane } = storeFixture();
    const p1 = mkPane();
    const p2 = mkPane();
    const s1 = agents.attachRunner({ pane_id: p1, cwd: '/x', session_id: SID });
    expect(s1.writer).toBe('sdk');
    expect(s1.view_mode).toBe('chat');
    expect(s1.lineage).toEqual([SID]);

    // Re-attach with a new sid extends the lineage, keeps history.
    const s2 = agents.attachRunner({ pane_id: p1, cwd: '/x', session_id: 'new-sid' });
    expect(s2.current_sid).toBe('new-sid');
    expect(s2.lineage).toEqual([SID, 'new-sid']);

    agents.detachRunner(p1);
    expect(agents.getByPane(p1)?.writer).toBe('none');

    // detachRunner never clobbers a TUI writer.
    agents.register({ pane_id: p2, session_id: SID });
    agents.detachRunner(p2);
    expect(agents.getByPane(p2)?.writer).toBe('tui');
  });

  it('reconcileStartup clears stale sdk writers', () => {
    const { agents, mkPane } = storeFixture();
    const p1 = mkPane();
    agents.attachRunner({ pane_id: p1, cwd: '/x', session_id: SID });
    agents.reconcileStartup();
    expect(agents.getByPane(p1)?.writer).toBe('none');
    // view_mode survives — the pane still shows chat when the runner re-hellos.
    expect(agents.getByPane(p1)?.view_mode).toBe('chat');
  });
});
