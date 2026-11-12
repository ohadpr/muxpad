// THE SERVER'S HALF of a remote runner fetching an attachment: an `attachment`
// frame on /ws/agent-runner/:paneId is answered on the same socket with the
// bytes, or refused with a reason. Real ws.ts handler, real socket.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';
import type { ServerFrame } from './protocol.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'muxpad-att-relay-'));
  mkdirSync(join(dataDir, 'attachments'));
  // A file OUTSIDE the attachments dir, for the traversal attempt to reach for.
  writeFileSync(join(dataDir, 'secret.png'), 'SECRET');
  writeFileSync(join(dataDir, 'attachments', '3f2a9c1e.png'), 'PNGBYTES');
  writeFileSync(join(dataDir, 'attachments', 'notes.sh'), 'echo hi');
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', layout: 'p1', workspace_id: ws.id });
  const pane = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache: new PtydCache(),
    events: new EventBus(),
    dataDir,
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-runner/${pane.id}`);
  await new Promise<void>((r) => sock.once('open', () => r()));
  const frames: ServerFrame[] = [];
  sock.on('message', (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
  cleanup = async () => {
    sock.terminate();
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
    rmSync(dataDir, { recursive: true, force: true });
  };
  /** Ask for `name` the way the runner does; resolve with the answer for `id`. */
  const ask = async (id: string, name: string) => {
    sock.send(JSON.stringify({ t: 'attachment', id, name }));
    const deadline = Date.now() + 3000;
    for (;;) {
      const f = frames.find(
        (x) => (x.t === 'attachment-data' || x.t === 'attachment-missing') && x.id === id,
      );
      if (f) return f;
      if (Date.now() > deadline) throw new Error(`no answer for ${id}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ask };
}

describe('attachment frames on the runner socket', () => {
  it('answers a request with the file’s bytes', async () => {
    const { ask } = await boot();
    const f = await ask('a1', '3f2a9c1e.png');
    expect(f.t).toBe('attachment-data');
    if (f.t !== 'attachment-data') return;
    expect(f.name).toBe('3f2a9c1e.png');
    expect(Buffer.from(f.b64, 'base64').toString()).toBe('PNGBYTES');
  });

  it('refuses a traversal name — the file outside the dir is never read', async () => {
    const { ask } = await boot();
    const f = await ask('a2', '../secret.png');
    expect(f).toMatchObject({ t: 'attachment-missing', id: 'a2', reason: 'bad name' });
  });

  it('refuses an extension that is not an attachment type, even if the file exists', async () => {
    const { ask } = await boot();
    const f = await ask('a3', 'notes.sh');
    expect(f).toMatchObject({ t: 'attachment-missing', id: 'a3', reason: 'unsupported type' });
  });

  it('says not found for a name that is not there', async () => {
    const { ask } = await boot();
    const f = await ask('a4', 'deadbeef.png');
    expect(f).toMatchObject({ t: 'attachment-missing', reason: 'not found' });
  });
});
