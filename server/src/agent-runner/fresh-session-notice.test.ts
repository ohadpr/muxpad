import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';
import { markSessionTurned } from './session-marks.js';

// A brand-new chat binds with a sid whose transcript does not exist yet — the
// CLI writes it at the first prompt. The bind used to answer that with
// "No transcript found … could not be recovered" in every new chat. Only a
// session that has taken a turn (the runner's turn mark) can have lost history.

let ptyd: SpawnedPtyd | null = null;
let http: ReturnType<typeof createServer> | null = null;
let dataDir = '';
const prevDataDir = process.env.MUXPAD_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'fresh-notice-'));
  process.env.MUXPAD_DATA_DIR = dataDir;
});

afterEach(async () => {
  await ptyd?.cleanup();
  ptyd = null;
  const h = http;
  http = null;
  if (h) await new Promise<void>((r) => h.close(() => r()));
  if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
  else process.env.MUXPAD_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function boot() {
  const db = openDb(':memory:');
  ptyd = await spawnPtyd();
  const ws = new WorkspaceStore(db).create({ name: 'W' });
  const tab = new TabStore(db).create({ name: 'T', layout: 'p1', workspace_id: ws.id });
  const pane = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  http = createServer();
  attachWsServer({ http, db, ptyd: ptyd.client, cache: new PtydCache(), events: new EventBus() });
  await new Promise<void>((r) => http?.listen(0, '127.0.0.1', r));
  return { port: (http.address() as AddressInfo).port, paneId: pane.id };
}

async function framesFrom(url: string, ms: number): Promise<Record<string, unknown>[]> {
  const sock = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  sock.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    sock.once('open', () => resolve());
    sock.once('error', reject);
  });
  await new Promise((r) => setTimeout(r, ms));
  sock.close();
  return frames;
}

async function helloAndBind(sid: string) {
  const { port, paneId } = await boot();
  const runner = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
  await new Promise<void>((r) => runner.once('open', () => r()));
  runner.send(JSON.stringify({ t: 'hello', sid, cwd: '/tmp', pid: 1, turnActive: false }));
  await new Promise((r) => setTimeout(r, 150));
  const frames = await framesFrom(`ws://127.0.0.1:${port}/ws/chat/${paneId}`, 300);
  runner.close();
  return frames.filter((f) => f.t === 'notice').map((f) => String(f.message));
}

describe('chat bind: a session with no transcript', () => {
  it('says nothing when the session has never taken a turn (a new chat)', async () => {
    const notices = await helloAndBind('aaaaaaaa-0000-4000-8000-000000000001');
    expect(notices.filter((m) => /No transcript found/.test(m))).toEqual([]);
  });

  it('still warns when a session that HAD turns has lost its transcript', async () => {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000002';
    markSessionTurned(sid);
    const notices = await helloAndBind(sid);
    expect(notices.some((m) => /No transcript found/.test(m))).toBe(true);
  });
});
