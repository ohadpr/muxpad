import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { openDb } from './store/db.js';
import { PaneManager } from './runtime/PaneManager.js';
import { attachWsServer } from './ws.js';
import { encodeInput, decodeServerMessage } from '@muxpad/shared';
import type { AddressInfo } from 'node:net';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

async function bootServer() {
  const db = openDb(':memory:');
  const paneManager = new PaneManager();
  const workspaces = new TabStore(db);
  const panes = new PaneStore(db);
  const ws = workspaces.create({ name: 'W', layout: 'p1' });
  const pane = panes.create({ tab_id: ws.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  attachWsServer({ http, db, paneManager });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await paneManager.killAll();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { port, paneId: pane.id };
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
});
