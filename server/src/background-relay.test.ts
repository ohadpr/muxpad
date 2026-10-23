import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { attachWsServer } from './ws.js';

/**
 * BACKGROUND SHELL COMMANDS REACHING THE CHAT.
 *
 * The runner has always reported them (`{t:'background', live}`), and the
 * server has always used that to settle a worker whose turn ended with one
 * still going. Nothing forwarded it to the browser, so the cockpit showed
 * NOTHING for the only kind of live work it could not see: no row, no mark,
 * no count — just a completion notice in the log, minutes later, which read
 * as "what is this and why is it not a sub-agent?".
 *
 * Two things have to hold: a chat that is open hears about the change, and a
 * chat that connects LATER is told the current number — a build running for
 * twenty minutes must not be invisible to a reload.
 */

const sockets: WebSocket[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const h of servers.splice(0)) h.close();
});

async function boot() {
  const db = openDb(':memory:');
  const workspace = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: workspace.id });
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: 'muxpad agent' });
  const http = createServer();
  servers.push(http);
  attachWsServer({
    http,
    db,
    events: new EventBus(),
    cache: new PtydCache(),
    ptyd: { on: () => {} } as unknown as PtydClient,
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;

  /** Opens a socket AND starts collecting immediately — the session frame can
   *  arrive in the same tick as the open, so a listener attached afterwards
   *  misses the very thing these tests are about. */
  const open = async (path: string) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(sock);
    const seen: Array<Record<string, unknown>> = [];
    sock.on('message', (data) => {
      try {
        seen.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // not ours
      }
    });
    await new Promise<void>((resolve, reject) => {
      sock.once('open', resolve);
      sock.once('error', reject);
    });
    return { sock, seen };
  };

  const { sock: runner } = await open(`/ws/agent-runner/${pane.id}`);
  runner.send(
    JSON.stringify({
      t: 'hello',
      sid: '11111111-2222-3333-4444-555555555555',
      cwd: '/tmp',
      pid: 4242,
      turnActive: false,
    }),
  );
  return { pane, open, runner };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('the background-command count', () => {
  it('reaches an open chat when it changes', async () => {
    const { pane, open, runner } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle();

    runner.send(JSON.stringify({ t: 'background', live: 2 }));
    await settle();

    const frames = seen.filter((f) => f.t === 'background');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.live).toBe(2);
  });

  it('is on the session frame, so a reload is not blind to a running build', async () => {
    const { pane, open, runner } = await boot();
    runner.send(JSON.stringify({ t: 'background', live: 3 }));
    await settle();

    // Somebody opens the chat now — long after the command started.
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle(400);

    const session = seen.find((f) => f.t === 'session');
    expect(session?.background).toBe(3);
  });

  it('says nothing at all when nothing is running', async () => {
    const { pane, open } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle(400);
    // Absent, not `background: 0` — every other backend sends no such field,
    // and absence already reads as none everywhere.
    const session = seen.find((f) => f.t === 'session');
    expect(session && 'background' in session).toBe(false);
  });

  it('reports the drain, so the cell can go away', async () => {
    const { pane, open, runner } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle();

    runner.send(JSON.stringify({ t: 'background', live: 1 }));
    await settle();
    runner.send(JSON.stringify({ t: 'background', live: 0 }));
    await settle();

    expect(seen.filter((f) => f.t === 'background').map((f) => f.live)).toEqual([1, 0]);
  });

  it('ignores a frame that is not a number', async () => {
    const { pane, open, runner } = await boot();
    const { seen } = await open(`/ws/chat/${pane.id}`);
    await settle();
    runner.send(JSON.stringify({ t: 'background', live: 'two' }));
    await settle();
    expect(seen.filter((f) => f.t === 'background')).toHaveLength(0);
  });
});
