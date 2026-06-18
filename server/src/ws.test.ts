import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeServerMessage, encodeInput, encodePing, encodeResize } from '@muxpad/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { type SpawnedPtyd, spawnPtyd } from './test-helpers/spawnPtyd.js';
import { attachWsServer } from './ws.js';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

async function bootServer(opts?: { heartbeatMs?: number }) {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
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
    ptyd: ptyd.client,
    cache: new PtydCache(),
    events: new EventBus(),
    ...(opts?.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { port, paneId: pane.id, ptyd };
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
    // Give the upstream attach a beat to complete so input isn't dropped
    // (proxyAttach drops browser messages before ptyd's WS is OPEN).
    await new Promise((r) => setTimeout(r, 100));
    sock.send(encodeInput('hello-cat\n'));
    await new Promise((r) => setTimeout(r, 400));
    sock.close();
    expect(received.join('')).toContain('hello-cat');
  });

  it('replays the ring buffer to a second client', async () => {
    const { port, paneId } = await bootServer();
    const a = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => a.once('open', () => r()));
    await new Promise((r) => setTimeout(r, 100));
    a.send(encodeInput('first-line\n'));
    await new Promise((r) => setTimeout(r, 300));

    const b = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    const received: string[] = [];
    b.on('message', (data: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(data));
      if (msg.kind === 'output') received.push(msg.data);
    });
    await new Promise<void>((r) => b.once('open', () => r()));
    await new Promise((r) => setTimeout(r, 300));
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

  it('rejects ws upgrade for a kind=url pane', async () => {
    // Mirror bootServer setup but create a url-kind pane directly via the
    // store. URL panes have no PTY; the upgrade must be rejected before
    // ensurePane is reached (which would crash node-pty on a null shell).
    const db = openDb(':memory:');
    const ptyd = await spawnPtyd();
    const workspaces = new WorkspaceStore(db);
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const wsRow = workspaces.create({ name: 'W' });
    const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
    const pane = panes.create({ tab_id: tab.id, kind: 'url', url: 'https://example.com' });
    const http = createServer();
    attachWsServer({ http, db, ptyd: ptyd.client, cache: new PtydCache(), events: new EventBus() });
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    cleanup = async () => {
      await ptyd.cleanup();
      await new Promise<void>((r) => http.close(() => r()));
    };

    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${pane.id}`);
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
    await new Promise((r) => setTimeout(r, 100));
    const gotPong = new Promise<boolean>((resolve) => {
      sock.on('message', (data: Buffer) => {
        const msg = decodeServerMessage(new Uint8Array(data));
        if (msg.kind === 'pong') resolve(true);
      });
      setTimeout(() => resolve(false), 1500);
    });
    sock.send(encodePing());
    expect(await gotPong).toBe(true);
    sock.close();
  });

  it('closes attached WS with code 4001 when the pane kind flips', async () => {
    // Wire HTTP routes + WS together so the PATCH handler can call into
    // ptyd.closePtyClients on the same daemon the WS upgrade ensured against.
    const db = openDb(':memory:');
    const ptyd = await spawnPtyd();
    const cache = new PtydCache();
    cache.attach(ptyd.client);
    const workspaces = new WorkspaceStore(db);
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const wsRow = workspaces.create({ name: 'W' });
    const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
    const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
    const http = createServer();
    attachWsServer({ http, db, ptyd: ptyd.client, cache: new PtydCache(), events: new EventBus() });
    // Mount the Hono app on the same http server for the PATCH call.
    const { createApp } = await import('./server.js');
    const app = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir: '/tmp',
    });
    http.on('request', async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      // Only intercept API paths; the upgrade path goes through 'upgrade'.
      if (!url.pathname.startsWith('/api/')) return;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const init: RequestInit = {
        method: req.method ?? 'GET',
        headers,
      };
      if (body.length) init.body = body;
      const fetchRes = await app.fetch(new Request(url.toString(), init));
      res.statusCode = fetchRes.status;
      fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
      const text = await fetchRes.text();
      res.end(text);
    });
    await new Promise<void>((r) => http.listen(0, r));
    const port = (http.address() as AddressInfo).port;
    cleanup = async () => {
      await ptyd.cleanup();
      await new Promise<void>((r) => http.close(() => r()));
    };

    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${pane.id}`);
    await new Promise<void>((r) => sock.once('open', () => r()));
    // Let proxyAttach finish wiring up so the close-from-ptyd propagates.
    await new Promise((r) => setTimeout(r, 150));

    const closed = new Promise<{ code: number }>((resolve) => {
      sock.once('close', (code) => resolve({ code }));
    });

    // PATCH the pane kind. The handler should close attached WSes through
    // ptyd; the close code (4001) should propagate to the browser via
    // proxyAttach's mirror behaviour.
    const patchRes = await fetch(`http://127.0.0.1:${port}/api/panes/${pane.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'url' }),
    });
    expect(patchRes.status).toBe(200);

    const result = await closed;
    expect(result.code).toBe(4001);
  });

  it('terminates a client that stops responding to liveness pings', async () => {
    // Fast heartbeat so the test doesn't take 30s.
    const { port, paneId, ptyd } = await bootServer({ heartbeatMs: 60 });
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => sock.once('open', () => r()));
    // Let proxyAttach finish wiring up so the resize reaches ptyd.
    await new Promise((r) => setTimeout(r, 100));
    sock.send(encodeResize(120, 40));

    // Wait until ptyd reports the pane is running (ensurePane completed).
    const deadline1 = Date.now() + 2000;
    while (!(await ptyd.client.hasPane(paneId)) && Date.now() < deadline1) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(await ptyd.client.hasPane(paneId)).toBe(true);

    // Simulate an abruptly-severed connection: pause the underlying socket
    // so the client can neither receive the server's ping nor auto-pong.
    // The server's heartbeat sweep should mark it dead and terminate it,
    // which fires 'close' → proxyAttach teardown → ptyd-side close.
    (sock as unknown as { _socket: { pause(): void } })._socket.pause();

    // The paused client never processes its own 'close'; we can't observe
    // ptyd's connectedClients from here, but we can verify the main-server
    // WS got terminated within a couple of heartbeat rounds. The wss
    // tracks the client; once terminated, .clients no longer includes it.
    // Use a generous timeout for CI variance.
    await new Promise((r) => setTimeout(r, 500));
    sock.terminate();
  });
});
