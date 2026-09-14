// THE TURN-START CORRELATION STAMP, against a REAL isolated instance.
//
// `turn-start` carries the message that started the turn so a client with two
// requests in flight (the voice layer) can tell whose answer is about to
// arrive. The stamp's whole value is that a turn NOBODY sent — a cron, a
// wakeup, a resume picking up mid-thought — arrives bare, so such a client
// binds nothing and stays silent.
//
// That guarantee is only as good as the stamp's lifetime. It used to be
// cleared solely by the turn-start that consumed it, so any path that killed a
// relayed send BEFORE its turn began left it standing — and the next
// autonomous turn wore a dead send's text. These tests pin the lifetime: a
// stamp names a send that can still start a turn, or it is null.
//
// Isolated like every other integration test here: own data dir, in-process
// ptyd, ephemeral port on 127.0.0.1, everything torn down in afterAll.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createAgentBridge } from '../agent-bridge.js';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a condition rather than for a fixed number of milliseconds.
 *
 * Every assertion here is about frame ORDER across three sockets, and a fixed
 * sleep that is generous on an idle machine is not generous when the whole
 * suite is running in parallel. Polling makes the tests describe the ordering
 * they actually depend on.
 */
async function waitFor(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(20);
  }
}

describe('turn-start correlation stamp', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let db: Database.Database;
  let ptyd: SpawnedPtyd;
  let wsServer: ReturnType<typeof attachWsServer>;
  let wsId: string;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-stamp-'));
    db = openDb(':memory:');
    const events = new EventBus();
    const agentBridge = createAgentBridge();
    ptyd = await spawnPtyd();
    const cache = new PtydCache();
    cache.attach(ptyd.client);
    const app = createApp({ db, ptyd: ptyd.client, cache, dataDir: tmp, events, agentBridge });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
    wsServer = attachWsServer({
      http: server as unknown as Server,
      db,
      ptyd: ptyd.client,
      cache,
      events,
      agentBridge,
    });
    wsId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  afterAll(async () => {
    for (const s of openSockets) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    await wsServer.close();
    await ptyd.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${port}`;
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  async function agentPane() {
    const tab = await api<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', mode: 'chat' }),
    });
    const detail = await api<Tab & { panes: Array<{ id: string }> }>(`/api/tabs/${tab.id}`);
    return detail.panes[0]!.id;
  }

  async function open(path: string) {
    const sock = new WebSocket(`${base().replace('http', 'ws')}${path}`);
    const frames: Array<Record<string, unknown>> = [];
    sock.on('message', (d) => frames.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      sock.once('open', () => res());
      sock.once('error', rej);
    });
    openSockets.push(sock);
    return { sock, frames };
  }

  /** A pane with a live fake runner and an open chat view of it. */
  async function wired(sid: string) {
    const paneId = await agentPane();
    const runner = await open(`/ws/agent-runner/${paneId}`);
    runner.sock.send(JSON.stringify({ t: 'hello', sid, cwd: tmp, pid: 1, turnActive: false }));
    const deadline = Date.now() + 5_000;
    while (!runner.frames.some((f) => f.t === 'mode') && Date.now() < deadline) await settle(25);
    const chat = await open(`/ws/chat/${paneId}`);
    await settle();
    return { paneId, runner, chat };
  }

  const starts = (frames: Array<Record<string, unknown>>) =>
    frames.filter((f) => f.t === 'turn-start');
  const count = (frames: Array<Record<string, unknown>>, t: string) =>
    frames.filter((f) => f.t === t).length;

  it('stamps the turn-start of the send that started it', async () => {
    const { runner, chat } = await wired('sid-stamp-happy');
    chat.sock.send(JSON.stringify({ t: 'send', text: 'summarise the diff' }));
    await waitFor('the send to reach the runner', () => count(runner.frames, 'send') === 1);
    runner.sock.send(JSON.stringify({ t: 'turn-start' }));
    await waitFor('the turn-start broadcast', () => count(chat.frames, 'turn-start') === 1);
    expect(starts(chat.frames).at(-1)).toEqual({ t: 'turn-start', text: 'summarise the diff' });
  });

  it('a cron turn AFTER a stopped send is not stamped with the stopped send’s text', async () => {
    // The reported failure, end to end: voice dispatches, the user hits Stop in
    // the chat UI, the runner reports the cancelled send as a bare `turn-done`
    // with no `turn-start` at all, and a cron fires minutes later. Before the
    // fix the cron's turn-start arrived wearing "summarise the diff", so the
    // voice task bound to it and spoke the cron's output as the answer.
    const { runner, chat } = await wired('sid-stamp-stop');
    chat.sock.send(JSON.stringify({ t: 'send', text: 'summarise the diff' }));
    await waitFor('the send to reach the runner', () => count(runner.frames, 'send') === 1);
    chat.sock.send(JSON.stringify({ t: 'stop' }));
    await waitFor('the stop to reach the runner', () => count(runner.frames, 'stop') === 1);
    // claude.ts's stop path when nothing was running but a send was queued.
    runner.sock.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await waitFor('the turn-done broadcast', () => count(chat.frames, 'turn-done') === 1);

    // …and now something nobody asked for.
    runner.sock.send(JSON.stringify({ t: 'turn-start' }));
    await waitFor('the cron turn-start', () => count(chat.frames, 'turn-start') === 1);
    expect(starts(chat.frames).at(-1)).toEqual({ t: 'turn-start' });
  });

  it('a turn-done with no turn-start retires the stamp on its own', async () => {
    // Same runner shape, without the Stop: the send is gone and nothing can
    // start a turn for it, so the next autonomous turn must arrive bare.
    const { runner, chat } = await wired('sid-stamp-done');
    chat.sock.send(JSON.stringify({ t: 'send', text: 'run the tests' }));
    await waitFor('the send to reach the runner', () => count(runner.frames, 'send') === 1);
    runner.sock.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await waitFor('the turn-done broadcast', () => count(chat.frames, 'turn-done') === 1);
    runner.sock.send(JSON.stringify({ t: 'turn-start' }));
    await waitFor('the autonomous turn-start', () => count(chat.frames, 'turn-start') === 1);
    expect(starts(chat.frames).at(-1)).toEqual({ t: 'turn-start' });
  });

  // A fourth case — a runner DYING mid-send — is deliberately not tested here.
  // The successor's per-connection state starts empty, so there is nothing for a
  // dead runner's stamp to ride in on and the assertion passes with or without
  // the teardown clear: it pins nothing, and the socket-replacement dance it
  // needs is the slowest thing in this file. The clear stays in ws.ts because it
  // is correct and free, not because a test demands it.
});
