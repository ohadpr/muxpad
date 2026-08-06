import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeServerMessage, encodeInput } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { PtydClient } from '../ptyd-client/PtydClient.js';
import { type PtydHandle, startPtyd } from '../ptyd/index.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type WsServerHandle, attachWsServer } from '../ws.js';

/**
 * A minimal "main server" boot: HTTP server + WS upgrade arm + connected
 * PtydClient + PtydCache, sharing the SQLite database file with previous /
 * future incarnations. This is the moral equivalent of `server/src/index.ts`,
 * trimmed to what the test needs (no static asset serving, no full Hono
 * route mount — we only exercise /ws/pane/:id).
 *
 * Each call yields a fresh PtydClient + PtydCache, so the test can prove
 * that NEW main-server state — not just the original client — sees the
 * ring buffer + live PTY survive across the restart.
 */
interface MainInstance {
  port: number;
  ptydClient: PtydClient;
  cache: PtydCache;
  cleanup(): Promise<void>;
}

async function spawnMain(opts: {
  socketPath: string;
  db: Database.Database;
}): Promise<MainInstance> {
  const ptydClient = new PtydClient({ socketPath: opts.socketPath });
  await new Promise<void>((r) => ptydClient.once('connected', () => r()));
  const cache = new PtydCache();
  cache.attach(ptydClient);
  // Mirror index.ts: seed cwds from SQLite so handlers don't see null during
  // the boot window before flushCwds replies.
  const paneStore = new PaneStore(opts.db);
  cache.seedCwds(paneStore.listCwds());

  const http: HttpServer = createServer();
  const wsHandle: WsServerHandle = attachWsServer({
    http,
    db: opts.db,
    ptyd: ptydClient,
    cache,
    events: new EventBus(),
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = ((http as unknown as NetServer).address() as AddressInfo).port;
  return {
    port,
    ptydClient,
    cache,
    async cleanup() {
      // Mirrors index.ts shutdown: close browser-facing WSes first, then
      // disconnect from ptyd, then the http server. Crucially we do NOT
      // call any ptyd-level killAll — ptyd outlives this main server.
      await wsHandle.close();
      await ptydClient.close();
      // closeAllConnections forces keep-alive sockets to drop so close()
      // resolves promptly even with idle clients lingering.
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  // LIFO teardown so the daemons stay up while their clients close.
  for (const fn of cleanupFns.reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
  cleanupFns = [];
});

describe('main-server restart with persistent ptyd', () => {
  it('preserves running PTYs across a main-server restart', async () => {
    // 1. Per-test tmpdir. Holds both the ptyd socket and the SQLite file —
    //    both main-server incarnations share these.
    const dir = mkdtempSync(join(tmpdir(), 'main-restart-'));
    const socketPath = join(dir, 'ptyd.sock');
    const dbPath = join(dir, 'db.sqlite');
    cleanupFns.push(async () => rmSync(dir, { recursive: true, force: true }));

    // 2. Spawn ptyd. It stays up across both main-server lifetimes.
    const ptydHandle: PtydHandle = await startPtyd({
      socketPath,
      cwdPollInterval: 50,
      cmdPollInterval: 50,
    });
    cleanupFns.push(() => ptydHandle.stop());

    // 3. Persistent SQLite — same file across both main servers. Mirrors
    //    production where index.ts opens db.sqlite under config.dataDir.
    //    Direct-store creation (workspace/tab/pane) instead of going
    //    through HTTP keeps the test focused on the WS + ptyd interaction.
    //    We close + reopen the handle between mains to mimic the real
    //    "process restart" path.
    let db = openDb(dbPath);
    let workspaces = new WorkspaceStore(db);
    let tabs = new TabStore(db);
    let panes = new PaneStore(db);
    const wsRow = workspaces.create({ name: 'W' });
    const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
    // /bin/cat as the "shell" so input echoes back deterministically —
    // matches the pattern in ws.test.ts. Real shells produce
    // prompt-dependent output that flakes the assertion.
    const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: dir });
    const paneId = pane.id;

    // 4. Main #1: HTTP + WS bound to a free port; ptydClient owned by main #1.
    const main1 = await spawnMain({ socketPath, db });
    const main1Cleanup = () => main1.cleanup();
    cleanupFns.push(main1Cleanup);

    // 5. Browser WS to /ws/pane/:id. Send 'hello\n'; cat echoes it back.
    const sockA = new WebSocket(`ws://127.0.0.1:${main1.port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => sockA.once('open', () => r()));
    const receivedA: string[] = [];
    sockA.on('message', (data: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(data));
      if (msg.kind === 'output') receivedA.push(msg.data);
    });
    // proxyAttach takes a beat to wire up; input sent before ptyd's WS
    // is OPEN gets dropped. Same wait pattern as ws.test.ts.
    await new Promise((r) => setTimeout(r, 150));
    sockA.send(encodeInput('hello\n'));
    // Wait long enough for cat to echo + the byte stream to surface here.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !receivedA.join('').includes('hello')) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(receivedA.join('')).toContain('hello');

    // 6. Tear down main #1. Critical: ptyd stays up; the pane runtime
    //    survives in ptyd's memory along with its ring buffer.
    sockA.close();
    await main1.cleanup();
    // pop the cleanup we just consumed so afterEach doesn't double-cleanup.
    cleanupFns = cleanupFns.filter((f) => f !== main1Cleanup);

    // 7. Probe ptyd directly with a one-off client to PROVE the runtime
    //    is still there. This is the load-bearing assertion: it isolates
    //    "ptyd survives the main-server tear-down" from any subsequent
    //    behaviour of main #2.
    const probe = new PtydClient({ socketPath });
    await new Promise<void>((r) => probe.once('connected', () => r()));
    expect(await probe.hasPane(paneId)).toBe(true);
    await probe.close();

    // 8. Close + reopen the SQLite handle to mimic the real
    //    "process exits, process starts" sequence. Both main-server
    //    incarnations operate on the same on-disk file.
    db.close();
    db = openDb(dbPath);
    workspaces = new WorkspaceStore(db);
    tabs = new TabStore(db);
    panes = new PaneStore(db);
    // Sanity: the persisted pane row is still findable from the fresh
    // SQLite handle (i.e. main #2 sees the same state via SQLite).
    expect(panes.getById(paneId)?.id).toBe(paneId);

    // 9. Main #2: same ptyd socket, same SQLite file, different port.
    const main2 = await spawnMain({ socketPath, db });
    cleanupFns.push(() => main2.cleanup());
    expect(main2.port).not.toBe(main1.port);

    // 10. Fresh browser WS via main #2. Expect: ring-buffer replay
    //     containing the prior 'hello' (snapshot is sent on attach in
    //     pty-bridge.ts), plus echo of a new input.
    const sockB = new WebSocket(`ws://127.0.0.1:${main2.port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => sockB.once('open', () => r()));
    const receivedB: string[] = [];
    sockB.on('message', (data: Buffer) => {
      const msg = decodeServerMessage(new Uint8Array(data));
      if (msg.kind === 'output') receivedB.push(msg.data);
    });

    // 11. Wait for the snapshot replay to include the original 'hello'.
    //     The replay arrives synchronously on attach; this is the
    //     evidence that the PTY runtime (and its ring buffer) survived.
    const snapDeadline = Date.now() + 2000;
    while (Date.now() < snapDeadline && !receivedB.join('').includes('hello')) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(receivedB.join('')).toContain('hello');

    // 12. Send fresh input through main #2. Verifies the PTY isn't
    //     just a corpse — it still accepts input and echoes through
    //     the new proxyAttach.
    await new Promise((r) => setTimeout(r, 150));
    sockB.send(encodeInput('world\n'));
    const echoDeadline = Date.now() + 2000;
    while (Date.now() < echoDeadline && !receivedB.join('').includes('world')) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(receivedB.join('')).toContain('world');

    sockB.close();
    // Explicit close to avoid a stray async warning at process exit. The
    // afterEach hook will also clean up main2 + ptyd + tmpdir.
    db.close();
    // This test spawns a real ptyd + two full main-server incarnations and
    // waits on ~5 real byte-stream round-trips. Under a parallel full-suite run
    // it starves against the 5s default and flakes on a 10s cap; 30s gives the
    // machine room without masking a genuine hang (a real regression still
    // fails its inner 2s polling deadlines with a clear assertion).
  }, 30_000);
});
