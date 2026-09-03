import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { PtydCache, decoratePane } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { attachWsServer } from '../ws.js';

/**
 * THE SERVER'S MIRROR of a pane's subagent roster, audited against a fake
 * runner on an isolated instance.
 *
 * The live symptom this file pins: a pane reported `agents: 8` (and therefore
 * `status: working` — a spinner that never stops) with exactly one real
 * subagent, and the number only ever grew.
 *
 * The mirror itself is per-CONNECTION (`conn.subagents`, rebuilt from the
 * runner's `onConnected` re-announce), so a reconnect cannot merge stale ids
 * back in. What is NOT per-connection is `PtydCache.subagentCounts` — the
 * number `GET /api/panes` renders and `getStatus` reads. It was written from
 * the frame handler and cleared from teardown, and teardown is DELIBERATELY
 * muted for a displaced runner ("a replaced socket must not detach its
 * successor"). So a runner that is replaced rather than closed left its count
 * behind with nothing alive that could ever retire it.
 *
 * No ptyd here on purpose: nothing on this path touches it, and a real pty
 * daemon is the flakiest dependency in the suite.
 */

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

/** Enough PtydClient for the runner/chat ws paths, which never call into it. */
const stubPtyd = () =>
  ({
    socketPath: '/tmp/muxpad-test-never-connected.sock',
    getForegroundCommand: async () => null,
    killPane: async () => {},
    ensurePane: async () => {},
    on: () => {},
  }) as unknown as PtydClient;

async function boot() {
  const db = openDb(':memory:');
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const events = new EventBus();
  const w = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: w.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  const cache = new PtydCache();
  const wsServer = attachWsServer({ http, db, ptyd: stubPtyd(), cache, events });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await wsServer.close();
    await new Promise<void>((r) => http.close(() => r()));
  };
  const paneRow = () => panes.getById(pane.id);
  return {
    port,
    paneId: pane.id,
    cache,
    /** What `GET /api/panes` would render for this pane. */
    row: () => {
      const p = paneRow();
      if (!p) throw new Error('pane vanished');
      return decoratePane(cache, p) as unknown as { agents: number; status: string };
    },
  };
}

async function openSock(url: string): Promise<WebSocket> {
  const sock = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    sock.once('open', () => resolve());
    sock.once('error', reject);
  });
  return sock;
}

/** The runner's live roster as a fresh chat socket would render it. */
async function chatRoster(port: number, paneId: string): Promise<string[]> {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
  const ids = await new Promise<string[]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no session frame')), 4000);
    sock.on('message', (data) => {
      const f = JSON.parse(String(data)) as {
        t?: string;
        subagents?: Array<{ toolUseId: string }>;
      };
      if (f.t !== 'session') return;
      clearTimeout(t);
      resolve((f.subagents ?? []).map((s) => s.toolUseId));
    });
    sock.once('error', reject);
  });
  sock.close();
  return ids;
}

/** Poll until `pred()` holds — never assert on a fixed sleep. */
async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 15));
}

const SID = '77777777-6666-5555-4444-333333333333';
const hello = (pid: number, turnActive = false) =>
  JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid, turnActive });
const launch = (id: string, label: string) =>
  JSON.stringify({ t: 'subagent', progress: { toolUseId: id, steps: 0, label, seenAt: 1 } });
const finish = (id: string) =>
  JSON.stringify({ t: 'subagent', progress: { toolUseId: id, steps: 7, done: true } });

describe('server-side subagent mirror', () => {
  it('adds ONLY what the runner launched, and retires everything it ends', async () => {
    // Q2: is there an ADD path the runner cannot retire? The mirror is keyed by
    // `toolUseId` on both sides of the frame handler, so a `done` always names
    // the entry its progress created. Progress for an id the runner never sent
    // (nested-agent traffic) never reaches the server at all — the runner drops
    // it — but even if it did, the same key retires it.
    const { port, paneId, cache, row } = await boot();
    const runner = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(hello(1));
    runner.send(JSON.stringify({ t: 'turn-start' }));
    for (const i of [1, 2, 3]) runner.send(launch(`tu_${i}`, `w${i}`));
    await waitUntil(() => cache.getSubagentCount(paneId) === 3);
    expect(row()).toMatchObject({ agents: 3, status: 'working' });

    // The keepalive re-announces the same ids every 5s; it must not double-count.
    for (const i of [1, 2, 3]) runner.send(launch(`tu_${i}`, `w${i}`));
    // Progress on a live entry, same key.
    runner.send(
      JSON.stringify({
        t: 'subagent',
        progress: { toolUseId: 'tu_2', steps: 12, lastTool: 'Bash' },
      }),
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(cache.getSubagentCount(paneId)).toBe(3);
    expect(await chatRoster(port, paneId)).toEqual(['tu_1', 'tu_2', 'tu_3']);

    // A finish for an id that was never launched is inert (no underflow).
    runner.send(finish('tu_never'));
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.getSubagentCount(paneId)).toBe(3);

    // The turn ends with all three outstanding: a background Task outlives its
    // turn, so the roster — and therefore `working` — survives it.
    runner.send(JSON.stringify({ t: 'turn-done', ok: true }));
    await new Promise((r) => setTimeout(r, 120));
    expect(row()).toMatchObject({ agents: 3, status: 'working' });

    // Q5: the spinner is held by the roster ALONE. Retire it and the pane
    // settles — nothing else was keeping it lit. (The ROW reads `ready`, not
    // `idle`: the finished turn marked the pane unread. `working` is the part
    // that was the roster's doing, and it is gone.)
    for (const i of [1, 2, 3]) runner.send(finish(`tu_${i}`));
    await waitUntil(() => cache.getSubagentCount(paneId) === 0);
    expect(row()).toMatchObject({ agents: 0, status: 'ready' });
    expect(cache.getStatus(paneId, false)).toBe('idle');
    expect(await chatRoster(port, paneId)).toEqual([]);
    runner.close();
  });

  it('REBUILDS the mirror on a mid-turn reconnect instead of merging', async () => {
    // Q3. The old connection's map dies with it; the runner re-announces its
    // live entries in onConnected. A reconnect that lands mid-turn is the
    // interesting one — it takes the hello branch that restores turnActive.
    const { port, paneId, cache } = await boot();
    const first = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    first.send(hello(1));
    first.send(JSON.stringify({ t: 'turn-start' }));
    for (const i of [1, 2, 3, 4]) first.send(launch(`tu_${i}`, `w${i}`));
    await waitUntil(() => cache.getSubagentCount(paneId) === 4);

    // The socket drops (server restart / ws blip). Two of the four finished
    // while it was down, so their `done` frames were never delivered.
    first.close();
    await waitUntil(() => cache.getSubagentCount(paneId) === 0);

    const second = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    second.send(hello(2, true));
    second.send(launch('tu_1', 'w1'));
    second.send(launch('tu_4', 'w4'));
    await waitUntil(() => cache.getSubagentCount(paneId) === 2);
    expect(await chatRoster(port, paneId)).toEqual(['tu_1', 'tu_4']);
    expect(cache.getStatus(paneId, false)).toBe('working');
    second.close();
  });

  it('a DISPLACED runner leaves no ghost count behind (the stuck spinner)', async () => {
    // THE DRIFT. A respawned runner may register before the old socket's close
    // fires; the old conn's teardown then correctly refuses to act (it would
    // detach its successor) — and with it went the ONLY `setSubagentCount(0)`
    // on that path. The new runner has an empty roster, so it announces
    // nothing, and nothing else ever writes the count again: the pane renders
    // its predecessor's subagents forever and reads `working` for good.
    const { port, paneId, cache, row } = await boot();
    const first = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    first.send(hello(1));
    for (const i of [1, 2, 3]) first.send(launch(`tu_${i}`, `w${i}`));
    await waitUntil(() => cache.getSubagentCount(paneId) === 3);

    // A new runner process takes the pane over while the old socket is still
    // open — the server displaces it with 4001.
    const second = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    second.send(hello(2));
    await new Promise((r) => setTimeout(r, 250));

    // The live runner has no subagents, so neither may the pane.
    expect(await chatRoster(port, paneId)).toEqual([]);
    expect(row()).toMatchObject({ agents: 0, status: 'idle' });
    second.close();
  });

  it("a DISPLACED runner's open question does not wedge the pane blocked", async () => {
    // Same drift, other field: `blocked` is cleared by teardown and by a
    // matching question-done, and a displaced runner produces neither. The
    // successor re-delivers any question it is really holding (onConnected),
    // so the pane must start from unblocked.
    const { port, paneId, cache } = await boot();
    const first = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    first.send(hello(1));
    first.send(
      JSON.stringify({
        t: 'question',
        qid: 'q1',
        questions: [{ question: 'which one?', header: 'pick', options: [{ label: 'a' }] }],
      }),
    );
    await waitUntil(() => cache.getStatus(paneId, false) === 'blocked');

    const second = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    second.send(hello(2));
    await new Promise((r) => setTimeout(r, 250));
    expect(cache.getStatus(paneId, false)).toBe('idle');
    second.close();
  });

  it('a runner death mid-turn clears the roster and the pane stops spinning', async () => {
    // The runner's subagents die with its process and nothing will ever report
    // them done — teardown is their only retirement edge.
    const { port, paneId, cache, row } = await boot();
    const runner = await openSock(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    runner.send(hello(1));
    runner.send(JSON.stringify({ t: 'turn-start' }));
    for (const i of [1, 2]) runner.send(launch(`tu_${i}`, `w${i}`));
    await waitUntil(() => cache.getSubagentCount(paneId) === 2);

    runner.terminate(); // SIGKILL-shaped: no close handshake
    await waitUntil(() => cache.getSubagentCount(paneId) === 0);
    expect(row()).toMatchObject({ agents: 0, status: 'idle' });
    expect(await chatRoster(port, paneId)).toEqual([]);
  });
});
