// The dead-runner sweep's most consequential distinction: "ptyd is
// unreachable" is NOT "the runner is dead".
//
// The sweep judges an agent pane by its pty foreground. `getForegroundCommand`
// only REJECTS when the ptyd socket isn't open (an unknown pane RESOLVES with
// null), so a rejection means liveness is unknown. Treating it as death meant a
// multi-minute ptyd outage spent every agent pane's whole restart budget on
// panes that were fine, marked them dead, and — the part that isn't
// recoverable — CLEARED THEIR DURABLE SEND QUEUES. Reconnect couldn't undo it:
// given-up panes are skipped.
//
// Driving this at its real cadence would take minutes (20s sweep, 45s
// cooldown, 3 attempts), so the sweep is exposed as a handle method and called
// directly. The FIRST sweep is the whole test: with the bug it already spends
// an attempt and announces "agent process died — restarting (attempt 1/3)".
// The give-up that clears the queue is three cooldowns further on, which no
// test can reach without an injectable clock — but it is only reachable
// through the attempt this test proves is never spent.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import { RESPAWN_STARTUP_GRACE_MS } from './respawn-policy.js';
import { AgentQueueStore } from './store/AgentQueueStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { spawnPtyd } from './test-helpers/spawnPtyd.js';
import { attachWsServer } from './ws.js';

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
  const wsRow = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
  const pane = panes.create({
    tab_id: tab.id,
    shell: '/bin/cat',
    cwd: '/tmp',
    // The durable marker the sweep selects on.
    startup_cmd: 'muxpad agent',
  });
  // Past the startup grace, so the sweep is willing to judge it.
  db.prepare('UPDATE panes SET created_at = ? WHERE id = ?').run(
    Date.now() - RESPAWN_STARTUP_GRACE_MS * 10,
    pane.id,
  );
  const http = createServer();
  const handle = attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache: new PtydCache(),
    events: new EventBus(),
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await handle.close();
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { db, handle, ptyd, port, paneId: pane.id };
}

/** Open a chat socket and collect the frames the server broadcasts to it. */
async function openChat(port: number, paneId: string) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
  const frames: Array<Record<string, unknown>> = [];
  sock.on('message', (data: Buffer) => {
    try {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // non-JSON frame — not something this test looks at
    }
  });
  await new Promise<void>((r) => sock.once('open', () => r()));
  const restarts = () =>
    frames.filter(
      (f) => typeof f.message === 'string' && /agent process died|agent exited/.test(f.message),
    );
  return { sock, frames, restarts };
}

/** Let broadcast frames traverse the loopback socket before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('dead-runner sweep vs a ptyd outage', () => {
  it('spends an attempt when ptyd answers "no runner" — the control case', async () => {
    // ptyd is UP and resolves `cmd: null` (nothing ever attached to this pane,
    // so there is no pty and no foreground). That is a real dead runner, and
    // the sweep must act on it — otherwise the test below proves nothing.
    const { handle, port, paneId } = await boot();
    const chat = await openChat(port, paneId);
    await handle.sweepDeadRunners();
    await settle();
    expect(chat.restarts()).toHaveLength(1);
    chat.sock.close();
  });

  it('burns no attempt, says nothing, and keeps the queue when ptyd is unreachable', async () => {
    const { db, handle, ptyd, port, paneId } = await boot();
    const chat = await openChat(port, paneId);
    const queue = new AgentQueueStore(db);
    queue.enqueue(paneId, 'do the thing');
    // Take ptyd away. Every control RPC now rejects with 'ptyd disconnected' —
    // liveness UNKNOWN, not dead.
    await ptyd.client.close();

    for (let i = 0; i < 5; i++) await handle.sweepDeadRunners();
    await settle();

    expect(chat.restarts()).toEqual([]);
    // The queue is what makes this a data-loss bug rather than a noisy-log one.
    expect(queue.list(paneId).map((r) => r.text)).toEqual(['do the thing']);
    chat.sock.close();
  });
});
