/**
 * A throwaway, fully ISOLATED muxpad instance for taking screenshots.
 *
 * Own temp data dir, own ptyd socket, bound to 127.0.0.1 on an ephemeral port,
 * an in-memory database, and a FAKE agent runner speaking /ws/agent-runner —
 * the same trick the step1-ux integration test uses. Nothing here touches
 * ~/.muxpad, the launchd-managed daemon, or the network.
 *
 * Run:  npx tsx scripts/shot-harness.mts
 * It prints one JSON line with the port and the ids a driver needs, then waits
 * for SIGTERM/SIGINT and tears everything down.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import type { Tab } from '@muxpad/shared';
import { WebSocket } from 'ws';
import { recordModelCatalog } from '../src/agent-model-catalog.js';
import { createAgentBridge } from '../src/agent-bridge.js';
import { EventBus } from '../src/events.js';
import { PtydCache } from '../src/ptyd-cache.js';
import { createApp } from '../src/server.js';
import { mountStaticWeb } from '../src/static-assets.js';
import { openDb } from '../src/store/db.js';
import { WorkspaceStore } from '../src/store/WorkspaceStore.js';
import { spawnPtyd } from '../src/test-helpers/spawnPtyd.js';
import { attachWsServer } from '../src/ws.js';

const tmp = mkdtempSync(join(tmpdir(), 'muxpad-shots-'));
process.env.MUXPAD_DATA_DIR = tmp;

const db = openDb(':memory:');
const events = new EventBus();
const agentBridge = createAgentBridge();
const ptyd = await spawnPtyd();
const cache = new PtydCache();
cache.attach(ptyd.client);

const app = createApp({ db, ptyd: ptyd.client, cache, dataDir: tmp, events, agentBridge });
mountStaticWeb(app, join(import.meta.dirname, '..', '..', 'web', 'dist'));
const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((r) => server.once('listening', () => r()));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no address');
const port = addr.port;
const wsServer = attachWsServer({
  http: server as unknown as Server,
  db,
  ptyd: ptyd.client,
  cache,
  events,
  agentBridge,
});

const base = `http://127.0.0.1:${port}`;
const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

// Model lists exactly as a runner would have reported them — the launch card
// reads these back through /api/agent-launch/options.
recordModelCatalog(db, 'claude', [
  { value: 'default', displayName: 'Default' },
  { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-8' },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-4-5' },
  { value: 'haiku', displayName: 'Haiku' },
]);
recordModelCatalog(db, 'codex', [
  { value: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
  { value: 'gpt-5', displayName: 'GPT-5' },
]);

// A few "recent folders" the picker can offer. Real directories (the picker
// filters out any that don't exist), seeded through session_history so they
// carry a recency order.
const repo = join(import.meta.dirname, '..', '..');
const folders = [repo, tmp];
folders.forEach((cwd, i) => {
  db.prepare(
    'INSERT INTO session_history (sid, pane_id, assistant, cwd, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`seed-${i}`, `seed-${i}`, 'claude', cwd, 1, 1000 - i);
});

const wsId = new WorkspaceStore(db).create({ name: 'Shots' }).id;
const tab = await api<Tab>('/api/tabs', {
  method: 'POST',
  body: JSON.stringify({ workspace_id: wsId, bootstrap: 'agent', backend: 'claude', mode: 'do' }),
});
const detail = await api<Tab & { panes: Array<{ id: string }> }>(`/api/tabs/${tab.id}`);
const paneId = detail.panes[0]!.id;

/** The fake runner: hello only. No transcript is ever written, so the pane sits
 *  in exactly the state the empty chat + its offer are for. */
const runner = new WebSocket(`${base.replace('http', 'ws')}/ws/agent-runner/${paneId}`);
await new Promise<void>((res, rej) => {
  runner.once('open', () => res());
  runner.once('error', rej);
});
const say = (o: unknown) => runner.send(JSON.stringify(o));
say({ t: 'hello', sid: '11111111-2222-3333-4444-555555555555', cwd: repo, pid: 1, turnActive: false });
say({
  t: 'status',
  model: 'opus',
  activeModel: 'claude-opus-4-8',
  context: { pct: 4, tokens: 8000, max: 200000 },
  models: [
    { value: 'default', displayName: 'Default' },
    { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-8' },
    { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-4-5' },
  ],
});

// Behave like a REAL runner after a conversion: the route rewrites the pane's
// startup_cmd and respawns the pty, and the new process says hello declaring
// its backend. Poll for that rewrite and re-hello, so the screenshots show the
// actual end state (Codex identity + the receipt), not a half-converted pane.
let lastCmd = 'muxpad agent --mode do';
setInterval(() => {
  const row = db.prepare('SELECT startup_cmd FROM panes WHERE id = ?').get(paneId) as
    | { startup_cmd: string | null }
    | undefined;
  const cmd = row?.startup_cmd ?? '';
  if (!cmd || cmd === lastCmd) return;
  lastCmd = cmd;
  const backend = /--backend (codex|cursor)/.exec(cmd)?.[1] ?? 'claude';
  const cwdRow = db.prepare('SELECT cwd FROM panes WHERE id = ?').get(paneId) as { cwd: string };
  say({
    t: 'hello',
    sid: `sid-${backend}-${Date.now()}`,
    cwd: cwdRow.cwd,
    pid: 2,
    backend,
    turnActive: false,
  });
}, 250);

process.stdout.write(`${JSON.stringify({ port, wsId, tabId: tab.id, tabSlug: tab.slug, paneId, tmp })}\n`);

const shutdown = async () => {
  try {
    runner.close();
  } catch {
    // already gone
  }
  await wsServer.close();
  await ptyd.cleanup();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
