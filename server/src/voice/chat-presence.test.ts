import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { attachWsServer } from '../ws.js';

/**
 * The wire between "the chat view went away" and "stop billing".
 *
 * The policy lives in VoiceSessionManager (and is tested there); what this file
 * proves is that the ws layer actually reports presence — a cap nobody calls is
 * not a cap. Chat sockets never touch ptyd (they tail the transcript JSONL), so
 * this boots the ws layer against a stub client rather than a spawned daemon.
 */

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function boot() {
  const db = openDb(':memory:');
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const w = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: w.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const presence: Array<{ paneId: string; clients: number }> = [];
  const http = createServer();
  const stubPtyd = { on: () => {}, socketPath: '/dev/null' } as unknown as PtydClient;
  const handle = attachWsServer({
    http,
    db,
    ptyd: stubPtyd,
    cache: new PtydCache(),
    events: new EventBus(),
    onChatPresence: (paneId, clients) => presence.push({ paneId, clients }),
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  cleanup = async () => {
    await handle.close();
    await new Promise<void>((r) => http.close(() => r()));
    db.close();
  };
  return { port, paneId: pane.id, presence };
}

const openChat = (port: number, paneId: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/${paneId}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

describe('chat-socket presence → voice', () => {
  it('reports the live client count as chat views come and go', async () => {
    const { port, paneId, presence } = await boot();

    const a = await openChat(port, paneId);
    await waitUntil(() => presence.length >= 1);
    expect(presence.at(-1)).toEqual({ paneId, clients: 1 });

    const b = await openChat(port, paneId);
    await waitUntil(() => presence.some((p) => p.clients === 2));
    expect(presence.some((p) => p.clients === 2)).toBe(true);

    // One of two closing is NOT a disconnect — the other view is still there.
    b.close();
    await waitUntil(() => presence.at(-1)?.clients === 1);
    expect(presence.at(-1)).toEqual({ paneId, clients: 1 });

    // The last one closing is the signal that arms the hang-up.
    a.close();
    await waitUntil(() => presence.at(-1)?.clients === 0);
    expect(presence.at(-1)).toEqual({ paneId, clients: 0 });
  });
});
