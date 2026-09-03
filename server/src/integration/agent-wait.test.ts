import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type ServerType, serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createAgentBridge } from '../agent-bridge.js';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const execFileAsync = promisify(execFile);

const MUXPAD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'muxpad',
);

const SID = '99999999-8888-7777-6666-555555555555';

/**
 * `muxpad agent wait` end-to-end against a real HTTP + WS server: the wait
 * must key on the runner registry's REAL turn state (turn_active via
 * GET /api/agent-sessions/by-pane), never the pty-activity `busy` flag — a
 * worker whose terminal streams dev-server logs used to read busy forever
 * and hang the wait.
 */
describe('muxpad agent wait (CLI ↔ turn state)', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let ptyd: SpawnedPtyd;
  let cache: PtydCache;
  let panes: PaneStore;
  let tabId: string;
  let env: NodeJS.ProcessEnv;
  let wsServer: ReturnType<typeof attachWsServer>;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-wait-'));
    const db = openDb(':memory:');
    const events = new EventBus();
    const agentBridge = createAgentBridge();
    ptyd = await spawnPtyd();
    cache = new PtydCache();
    cache.attach(ptyd.client);
    const app = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir: tmp,
      events,
      agentBridge,
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
    wsServer = attachWsServer({
      http: server as unknown as Server,
      db,
      ptyd: ptyd.client,
      cache,
      events,
      agentBridge,
    });
    const workspaces = new WorkspaceStore(db);
    const tabs = new TabStore(db);
    panes = new PaneStore(db);
    const w = workspaces.create({ name: 'W' });
    tabId = tabs.create({ name: 'T', layout: '', workspace_id: w.id }).id;
    env = { ...process.env, MUXPAD_API_URL: `http://127.0.0.1:${port}` };
  });

  afterAll(async () => {
    await wsServer.close();
    await ptyd.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  const mkPane = () => panes.create({ tab_id: tabId, shell: '/bin/cat', cwd: '/tmp' }).id;

  /** Connect a fake runner and say hello with the given turn state. */
  const connectRunner = async (paneId: string, turnActive: boolean): Promise<WebSocket> => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-runner/${paneId}`);
    await new Promise<void>((resolveOpen, reject) => {
      sock.once('open', () => resolveOpen());
      sock.once('error', reject);
    });
    sock.send(JSON.stringify({ t: 'hello', sid: SID, cwd: '/tmp', pid: 1, turnActive }));
    await new Promise((r) => setTimeout(r, 200)); // let the registry settle
    return sock;
  };

  const wait = (paneId: string, ...extra: string[]) =>
    execFileAsync(MUXPAD_BIN, ['agent', 'wait', paneId, ...extra], { env, encoding: 'utf-8' });

  it('exits 1 with a clear message for a pane with no agent session', async () => {
    const paneId = mkPane();
    await expect(wait(paneId)).rejects.toMatchObject({ code: 1 });
    const err = (await wait(paneId).catch((e) => e)) as { stderr: string };
    expect(err.stderr).toContain('no agent session');
  });

  it('returns 0 immediately for a streaming pane whose agent is NOT mid-turn', async () => {
    const paneId = mkPane();
    const runner = await connectRunner(paneId, false);
    // Simulate a terminal streaming output: pane `busy` reads true while the
    // agent is idle. Under the old busy-based check this hung forever.
    cache.setAgentBusy(paneId, true);
    const started = Date.now();
    const { stdout } = await wait(paneId);
    expect(stdout).toContain('already idle');
    expect(Date.now() - started).toBeLessThan(3000);
    runner.close();
  });

  it('resolves on turn-done for a mid-turn runner even while the pane streams', async () => {
    const paneId = mkPane();
    const runner = await connectRunner(paneId, true);
    cache.setAgentBusy(paneId, true); // pty streaming on top of the real turn
    const pending = wait(paneId, '--timeout=15');
    // Give the CLI time to subscribe + read state, then end the turn.
    setTimeout(() => runner.send(JSON.stringify({ t: 'turn-done', ok: true })), 1200);
    const { stdout } = await pending;
    expect(stdout).toContain('turn done');
    runner.close();
  });

  it('exits 2 when the runner reports fatal mid-wait', async () => {
    const paneId = mkPane();
    const runner = await connectRunner(paneId, true);
    const pending = wait(paneId, '--timeout=15');
    setTimeout(() => runner.send(JSON.stringify({ t: 'fatal', error: 'boom' })), 1200);
    await expect(pending).rejects.toMatchObject({ code: 2 });
    runner.close();
  });

  it('exits 3 on --timeout while the turn never ends', async () => {
    const paneId = mkPane();
    const runner = await connectRunner(paneId, true);
    await expect(wait(paneId, '--timeout=2')).rejects.toMatchObject({ code: 3 });
    runner.close();
  });
}, 30_000);
