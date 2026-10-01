import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { AgentQueueStore } from './store/AgentQueueStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { attachWsServer } from './ws.js';

it('identifies the exact queue relay before removing the row, but not the runner echo', async () => {
  const db = openDb(':memory:');
  const workspace = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: workspace.id });
  const pane = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: 'muxpad agent' });
  const queue = new AgentQueueStore(db);
  const row = queue.enqueue(pane.id, 'queued work');
  const events = new EventBus();
  const starts: Array<{ id: string | undefined; head: string | undefined }> = [];
  let resolveEcho!: () => void;
  const echo = new Promise<void>((resolve) => {
    resolveEcho = resolve;
  });
  events.subscribe((e) => {
    if (e.type !== 'agent_turn' || e.phase !== 'start') return;
    starts.push({ id: e.queue_id, head: queue.peek(pane.id)?.id });
    if (starts.length === 2) resolveEcho();
  });
  const http = createServer();
  const ws = attachWsServer({
    http,
    db,
    events,
    cache: new PtydCache(),
    ptyd: { on: () => {} } as unknown as PtydClient,
  });
  let runner: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    runner = new WebSocket(
      `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws/agent-runner/${pane.id}`,
    );
    await new Promise<void>((resolve, reject) => {
      runner!.once('open', resolve);
      runner!.once('error', reject);
    });
    runner.on('message', (data) => {
      if (JSON.parse(String(data)).t === 'send') runner!.send(JSON.stringify({ t: 'turn-start' }));
    });
    runner.send(
      JSON.stringify({
        t: 'hello',
        sid: '11111111-2222-3333-4444-555555555555',
        cwd: '/tmp',
        pid: 4242,
        turnActive: false,
      }),
    );
    await echo;
    expect(starts).toEqual([
      { id: row.id, head: row.id },
      { id: undefined, head: undefined },
    ]);
  } finally {
    runner?.terminate();
    await ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    db.close();
  }
});
