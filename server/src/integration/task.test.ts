// DURABLE TASKS end to end, against a REAL isolated instance: HTTP + WS + an
// in-process ptyd on its own unix socket, its own data dir, an ephemeral port,
// and a FAKE runner speaking the /ws/agent-runner protocol.
//
// What only an e2e can prove: that a continuation travels the SAME road a
// human message does — the real `submitSend`, the real durable queue, the real
// one-message-per-turn drain — and that every stop condition actually stops it
// in the live server rather than only in the pure function.
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
import { CONTINUATION_LIMIT } from '../chat/task-continue.js';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** Wait for a CONDITION, never for a duration — cron.test.ts's header has the
 *  measurement that made this the house rule, and the drain this file watches
 *  is the very path that was mistimed there (322ms against a 250ms sleep). */
async function until(what: string, cond: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await settle();
  }
}

describe('durable tasks e2e (isolated instance, fake runner)', { timeout: 30_000 }, () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let db: Database.Database;
  let ptyd: SpawnedPtyd;
  let wsServer: ReturnType<typeof attachWsServer>;
  let wsId: string;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-task-e2e-'));
    process.env.MUXPAD_DATA_DIR = tmp;
    db = openDb(join(tmp, 'db.sqlite'));
    const events = new EventBus();
    const agentBridge = createAgentBridge();
    ptyd = await spawnPtyd();
    process.env.MUXPAD_PTYD_SOCKET = ptyd.socketPath;
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
    // DELETED, not set to undefined: assigning `undefined` to a process.env
    // key stores the STRING "undefined", which a later reader treats as a real
    // path. Measured, after a comment in this repo claimed otherwise.
    Reflect.deleteProperty(process.env, 'MUXPAD_DATA_DIR');
    Reflect.deleteProperty(process.env, 'MUXPAD_PTYD_SOCKET');
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

  async function agentTab() {
    const tab = await api<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', mode: 'chat' }),
    });
    const detail = await api<Tab & { panes: Array<{ id: string }> }>(`/api/tabs/${tab.id}`);
    return { tabId: tab.id, paneId: detail.panes[0]?.id as string };
  }

  async function connectRunner(paneId: string, sid: string) {
    const sock = new WebSocket(`${base().replace('http', 'ws')}/ws/agent-runner/${paneId}`);
    const received: Array<Record<string, unknown>> = [];
    sock.on('message', (d) => received.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      sock.once('open', () => res());
      sock.once('error', rej);
    });
    openSockets.push(sock);
    sock.send(JSON.stringify({ t: 'hello', sid, cwd: tmp, pid: 1, turnActive: false }));
    await until('the runner to register', () => received.some((f) => f.t === 'mode'), 5_000);
    return {
      sock,
      sends: () => received.filter((f) => f.t === 'send') as Array<{ text: string }>,
      startTurn: () => sock.send(JSON.stringify({ t: 'turn-start' })),
      endTurn: (ok = true) => sock.send(JSON.stringify({ t: 'turn-done', ok })),
      question: (qid: string) =>
        sock.send(JSON.stringify({ t: 'question', qid, questions: [{ question: 'which?' }] })),
    };
  }

  const declare = (tabId: string, over: Record<string, unknown> = {}) =>
    api<{ task: { id: string } }>(`/api/tabs/${tabId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        request: 'ship the sidebar fix',
        criteria: 'the suite is green',
        next_step: 'run the migration against a copy',
        ...over,
      }),
    });
  const patch = (tabId: string, id: string, body: Record<string, unknown>) =>
    api(`/api/tabs/${tabId}/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const read = (tabId: string) =>
    api<{ open: { id: string; continuations: number } | null }>(`/api/tabs/${tabId}/tasks`);

  it('hands an open task back when the turn ends, as an ordinary send', async () => {
    const { tabId, paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-1');
    const { task } = await declare(tabId);

    runner.startTurn();
    await settle();
    runner.endTurn();

    await until('the continuation to reach the runner', () => runner.sends().length === 1);
    const text = runner.sends()[0]?.text ?? '';
    expect(text).toContain(`<muxpad-task id="${task.id}" attempt="1"`);
    expect(text).toContain('ship the sidebar fix'); // its own words, read back
    expect(text).toContain('the suite is green');
    // …and the attempt is spent, which is what bounds the loop.
    expect((await read(tabId)).open?.continuations).toBe(1);
  });

  it('does nothing at all for a chat with no task', async () => {
    // The safety property: nothing anybody has ever run changes behaviour
    // until an agent writes a task down.
    const { paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-none');
    runner.startTurn();
    await settle();
    runner.endTurn();
    await settle(400);
    expect(runner.sends()).toHaveLength(0);
  });

  it('stops after ONE when the task is not touched — the anti-loop, live', async () => {
    const { tabId, paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-stall');
    await declare(tabId);

    // Turn 1 ends → continuation 1.
    runner.startTurn();
    await settle();
    runner.endTurn();
    await until('the first continuation', () => runner.sends().length === 1);

    // The agent burns a turn and records NOTHING. No second continuation,
    // however long we wait — this is the degenerate loop that would otherwise
    // bounce off the same wall six times at full model price.
    runner.startTurn();
    await settle();
    runner.endTurn();
    await settle(600);
    expect(runner.sends()).toHaveLength(1);

    // One recorded step revives it.
    const open = (await read(tabId)).open as { id: string };
    await patch(tabId, open.id, { next_step: 'try the other query plan' });
    runner.startTurn();
    await settle();
    runner.endTurn();
    await until('the continuation after real progress', () => runner.sends().length === 2);
    expect(runner.sends()[1]?.text).toContain('attempt="2"');
  });

  it('does not continue a task the chat marked done', async () => {
    const { tabId, paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-done');
    const { task } = await declare(tabId);
    await patch(tabId, task.id, { state: 'done', evidence: 'commit abc123, suite green' });

    runner.startTurn();
    await settle();
    runner.endTurn();
    await settle(400);
    expect(runner.sends()).toHaveLength(0);
  });

  it('does not talk over a question the chat has asked', async () => {
    const { tabId, paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-blocked');
    await declare(tabId);

    runner.startTurn();
    await settle();
    runner.question('q1');
    await settle();
    runner.endTurn();
    await settle(400);
    expect(runner.sends()).toHaveLength(0);
  });

  it('does not re-send into a turn that FAILED', async () => {
    const { tabId, paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-failed');
    await declare(tabId);

    runner.startTurn();
    await settle();
    runner.endTurn(false);
    await settle(400);
    expect(runner.sends()).toHaveLength(0);
  });

  it('a human message resets the budget, so engaging buys more rope', async () => {
    const { tabId, paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-reset');
    const { task } = await declare(tabId);
    // Spend the whole budget by hand, as a run of continuations would.
    for (let i = 0; i < CONTINUATION_LIMIT; i++) {
      await patch(tabId, task.id, { next_step: `step ${i}` });
      db.prepare('UPDATE tasks SET continuations = continuations + 1 WHERE id = ?').run(task.id);
    }
    runner.startTurn();
    await settle();
    runner.endTurn();
    await settle(400);
    expect(runner.sends()).toHaveLength(0); // spent

    // A person says something. That is the one event that makes further
    // autonomous work reasonable again.
    await api(`/api/agent-sessions/${paneId}/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'carry on' }),
    });
    await until('the human message to reach the runner', () => runner.sends().length === 1);
    expect((await read(tabId)).open?.continuations).toBe(0);
    runner.endTurn();
    await until('a continuation after the reset', () => runner.sends().length === 2);
    expect(runner.sends()[1]?.text).toContain('<muxpad-task');
  });

  it('a continuation is not engagement — it cannot top up its own budget', async () => {
    // If the continuation read as a human message, `resetBudget` would fire on
    // every one of them and the bound would be decorative. This is the test
    // that `isMachineMessage` knows about the new marker.
    const { tabId, paneId } = await agentTab();
    const runner = await connectRunner(paneId, 'sid-task-selffeed');
    await declare(tabId);
    runner.startTurn();
    await settle();
    runner.endTurn();
    await until('the first continuation', () => runner.sends().length === 1);
    expect((await read(tabId)).open?.continuations).toBe(1);
  });

  it('a second declared task supersedes the first, keeping one open', async () => {
    const { tabId } = await agentTab();
    const first = await declare(tabId);
    const second = await declare(tabId, { request: 'actually, do the other thing' });
    const after = await read(tabId);
    expect(after.open?.id).toBe(second.task.id);
    const all = await api<{ tasks: Array<{ id: string; state: string; evidence: string | null }> }>(
      `/api/tabs/${tabId}/tasks`,
    );
    const old = all.tasks.find((t) => t.id === first.task.id);
    expect(old?.state).toBe('done');
    expect(old?.evidence).toContain('superseded');
  });

  it('refuses `done` with no evidence, and says why', async () => {
    const { tabId } = await agentTab();
    const { task } = await declare(tabId);
    const res = await fetch(`${base()}/api/tabs/${tabId}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'done' }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('evidence');
    expect((await read(tabId)).open?.id).toBe(task.id); // still open
  });

  it('will not let one chat close another chat’s task', async () => {
    const a = await agentTab();
    const b = await agentTab();
    const { task } = await declare(a.tabId);
    const res = await fetch(`${base()}/api/tabs/${b.tabId}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'done', evidence: 'not mine to close' }),
    });
    expect(res.status).toBe(404);
    expect((await read(a.tabId)).open?.id).toBe(task.id);
  });
});
