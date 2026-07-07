import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
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
  attachWsServer({ http, db, ptyd: ptyd.client, cache: new PtydCache(), events });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { port, paneId: pane.id, panes, agents, events };
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

    // Stop relays to the runner.
    chat.send(JSON.stringify({ t: 'stop' }));
    await fromServer.next((f) => f.t === 'stop');

    runner.close();
    chat.close();
    chat2.close();
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
