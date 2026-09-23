import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeServerMessage, encodeInput, encodePing } from '@muxpad/shared';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { TabActivity } from './tab-activity.js';
import { spawnPtyd } from './test-helpers/spawnPtyd.js';
import { attachWsServer } from './ws.js';

it('real terminal frames survive reconnect grace and flush the final key after the socket closes', async () => {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  const tabs = new TabStore(db);
  const ws = new WorkspaceStore(db).create({ name: 'activity probe' });
  const tab = tabs.create({ name: 'terminal', layout: '', workspace_id: ws.id });
  const pane = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/cat', cwd: ptyd.dir });
  // Watch the COLUMN, not the onWrite notification: notifications are filtered
  // to writes that can reorder the sidebar, and this fixture has one tab, so
  // only its first write qualifies. What this test is about is the write.
  const stamped = tabs.getById(tab.id)!.last_activity_at!;
  const writes: number[] = [];
  const poll = setInterval(() => {
    const at = tabs.getById(tab.id)?.last_activity_at;
    if (at != null && at !== stamped && at !== writes[writes.length - 1]) writes.push(at);
  }, 10);
  const activity = new TabActivity(db);
  activity.attach(ptyd.client);
  const http = createServer();
  const attached = attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache: new PtydCache(),
    events: new EventBus(),
    tabActivity: activity,
  });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${pane.id}`);
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    // Pong traverses the upstream attach. Wait for readiness, not a guessed
    // delay that drops the first input on a busy test machine.
    let ready = false;
    socket.on('message', (data: Buffer) => {
      if (decodeServerMessage(new Uint8Array(data)).kind === 'pong') ready = true;
    });
    const ping = setInterval(() => socket?.send(encodePing()), 25);
    try {
      await expect.poll(() => ready).toBe(true);
    } finally {
      clearInterval(ping);
    }
    expect(writes).toEqual([]); // replay/output remains behind grace
    socket.send(encodeInput('first'));
    await expect.poll(() => writes.length).toBe(1);
    const first = writes[0]!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.send(encodeInput('final'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.close();
    await expect.poll(() => writes.length, { timeout: 2500 }).toBe(2);
    expect(writes[1]).toBeGreaterThan(first);
    // It records the key time, not when the one-second flush fired.
    expect(writes[1]! - first).toBeLessThan(1000);
  } finally {
    clearInterval(poll);
    socket?.terminate();
    activity.forget(tab.id);
    await attached.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await ptyd.cleanup();
    db.close();
  }
});
