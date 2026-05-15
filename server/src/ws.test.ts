import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { openDb } from './store/db.js';
import { PaneManager } from './runtime/PaneManager.js';
import { attachWsServer } from './ws.js';
import { encodeInput, encodeResize, decodeServerMessage, encodePing } from '@muxpad/shared';
import type { AddressInfo } from 'node:net';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

async function bootServer(opts?: { heartbeatMs?: number }) {
  const db = openDb(':memory:');
  const paneManager = new PaneManager();
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const ws = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  attachWsServer({
    http,
    db,
    paneManager,
    ...(opts?.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await paneManager.killAll();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { port, paneId: pane.id, paneManager };
}

describe('WS server', () => {
  it('echoes input through cat and returns it as output', async () => {
    const { port, paneId } = await bootServer();
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => sock.once('open', () => r()));
    const received: string[] = [];
    sock.on('message', (data: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(data));
      if (msg.kind === 'output') received.push(msg.data);
    });
    sock.send(encodeInput('hello-cat\n'));
    await new Promise((r) => setTimeout(r, 300));
    sock.close();
    expect(received.join('')).toContain('hello-cat');
  });

  it('replays the ring buffer to a second client', async () => {
    const { port, paneId } = await bootServer();
    const a = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => a.once('open', () => r()));
    a.send(encodeInput('first-line\n'));
    await new Promise((r) => setTimeout(r, 200));

    const b = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    const received: string[] = [];
    b.on('message', (data: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(data));
      if (msg.kind === 'output') received.push(msg.data);
    });
    await new Promise<void>((r) => b.once('open', () => r()));
    await new Promise((r) => setTimeout(r, 200));
    a.close();
    b.close();
    expect(received.join('')).toContain('first-line');
  });

  it('rejects connection for missing pane', async () => {
    const { port } = await bootServer();
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/nope`);
    const result = await new Promise<'closed' | 'open'>((resolve) => {
      sock.once('open', () => resolve('open'));
      sock.once('close', () => resolve('closed'));
      sock.once('error', () => resolve('closed'));
    });
    expect(result).toBe('closed');
  });

  it('replies pong to a ping', async () => {
    const { port, paneId } = await bootServer();
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => sock.once('open', () => r()));
    const gotPong = new Promise<boolean>((resolve) => {
      sock.on('message', (data: Buffer) => {
        const msg = decodeServerMessage(new Uint8Array(data));
        if (msg.kind === 'pong') resolve(true);
      });
      setTimeout(() => resolve(false), 1000);
    });
    sock.send(encodePing());
    expect(await gotPong).toBe(true);
    sock.close();
  });

  it('terminates a client that stops responding to liveness pings', async () => {
    // Fast heartbeat so the test doesn't take 30s.
    const { port, paneId, paneManager } = await bootServer({ heartbeatMs: 60 });
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => sock.once('open', () => r()));
    // Report a size so the pane has a clientSizes entry to clean up.
    sock.send(encodeResize(120, 40));
    await new Promise((r) => setTimeout(r, 40));

    const runtime = paneManager.get(paneId);
    expect(runtime?.clientCount()).toBe(1);

    // Simulate an abruptly-severed connection: pause the underlying socket
    // so the client can neither receive the server's ping nor auto-pong.
    // The server's heartbeat sweep should mark it dead and terminate it,
    // which fires 'close' → removeClient server-side.
    (sock as unknown as { _socket: { pause(): void } })._socket.pause();

    // The paused client never processes its own 'close', so poll the
    // server-side count instead. With a 60ms heartbeat the ghost is gone
    // within ~2 sweeps.
    const deadline = Date.now() + 3000;
    while ((runtime?.clientCount() ?? 0) > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(runtime?.clientCount()).toBe(0);
    sock.terminate();
  });
});
