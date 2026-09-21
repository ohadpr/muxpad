// A MAIN-SERVER RESTART MUST NOT FORGET WHAT PTYD STILL KNOWS.
//
// ptyd outlives the main server by design. Its decoration bus
// (`paneTitle` / `paneFg` / `paneAttention`) is DIFF-DRIVEN, and the diff maps
// live in ptyd's PaneManager keyed by pane id — NOT per subscriber. So a fresh
// main server attaches to a ptyd that has already decided every current value
// is "unchanged", and is told nothing. Its PtydCache starts empty and stays
// empty for those three fields until the underlying value happens to move.
//
// That is not a boot window. For a pane sitting in `vim`, or one that rang the
// bell while you were away, it is the rest of that pane's life:
//
//   attention → getStatus drops `blocked` (the TOP precedence) to `idle`, so
//     the pane loses its × in the status rail AND the sidebar's "wants you
//     now" promotion (tab-activity.ts `wantsYou`). A routine restart silently
//     demotes the one state the nav exists to surface.
//   foreground_cmd / title → every pane's live label in the tab strip goes
//     blank.
//
// The fix is a `flushDecorations` snapshot RPC, taken on every ptyd
// (re)connect, exactly as `flushCwds` already does for cwd — the same problem,
// which cwd solved years ago and the other three fields never did.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeInput } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EventBus } from '../events.js';
import { PtydCache, decoratePane } from '../ptyd-cache.js';
import { PtydClient } from '../ptyd-client/PtydClient.js';
import { type PtydHandle, startPtyd } from '../ptyd/index.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type WsServerHandle, attachWsServer } from '../ws.js';

interface MainInstance {
  port: number;
  ptydClient: PtydClient;
  cache: PtydCache;
  cleanup(): Promise<void>;
}

/** index.ts's boot sequence, trimmed to the ptyd wiring this test is about. */
async function spawnMain(opts: {
  socketPath: string;
  db: Database.Database;
}): Promise<MainInstance> {
  const ptydClient = new PtydClient({ socketPath: opts.socketPath });
  const cache = new PtydCache();
  // ATTACH BEFORE WAITING, exactly as index.ts:91-93 does. The handshake
  // snapshot rides the cache's own `connected` listener, so a harness that
  // awaited `connected` first would register too late and silently test a
  // configuration production never runs.
  cache.attach(ptydClient);
  await new Promise<void>((r) => ptydClient.once('connected', () => r()));
  cache.seedCwds(new PaneStore(opts.db).listCwds());
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
      await wsHandle.close();
      await ptydClient.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
  cleanupFns = [];
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(30);
  }
}

describe('main-server restart: pane decorations survive', () => {
  it('re-reads fg + attention from the surviving ptyd instead of reading them as absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restart-deco-'));
    const socketPath = join(dir, 'ptyd.sock');
    const dbPath = join(dir, 'db.sqlite');
    cleanupFns.push(async () => rmSync(dir, { recursive: true, force: true }));

    // ptyd stays up across both main-server lifetimes — the whole point.
    const ptydHandle: PtydHandle = await startPtyd({
      socketPath,
      cwdPollInterval: 50,
      cmdPollInterval: 50,
    });
    cleanupFns.push(() => ptydHandle.stop());

    let db = openDb(dbPath);
    const wsRow = new WorkspaceStore(db).create({ name: 'W' });
    const tab = new TabStore(db).create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
    // /bin/cat as the shell: deterministic echo, and a stable foreground
    // command for the fg probe. A real shell's prompt output flakes this.
    const pane = new PaneStore(db).create({ tab_id: tab.id, shell: '/bin/cat', cwd: dir });
    const paneId = pane.id;

    const main1 = await spawnMain({ socketPath, db });
    const main1Cleanup = () => main1.cleanup();
    cleanupFns.push(main1Cleanup);

    const sock = new WebSocket(`ws://127.0.0.1:${main1.port}/ws/pane/${paneId}`);
    await new Promise<void>((r) => sock.once('open', () => r()));
    await settle(250);
    // Ring the bell through cat's ECHO so ptyd latches needsAttention. A char
    // code, not a literal BEL, because a literal one is invisible in source —
    // and note it must arrive as pty OUTPUT: PaneRuntime.write() CLEARS
    // attention, so an input frame alone would never set it.
    sock.send(encodeInput(`bell${String.fromCharCode(7)}\n`));
    await waitFor('main1 to see the foreground command', () => main1.cache.getFg(paneId) !== null);
    await waitFor('main1 to see attention', () => main1.cache.getAttention(paneId) === true);
    const fgBefore = main1.cache.getFg(paneId);
    expect(fgBefore).toBeTruthy();

    // ── The restart. ptyd, its ptys and its diff maps all survive. ──
    sock.close();
    await main1.cleanup();
    cleanupFns = cleanupFns.filter((f) => f !== main1Cleanup);
    db.close();
    db = openDb(dbPath);

    const main2 = await spawnMain({ socketPath, db });
    cleanupFns.push(() => main2.cleanup());

    // ptyd's own answer is the ground truth the new server must converge on.
    expect(await main2.ptydClient.getForegroundCommand(paneId)).toBe(fgBefore);

    await waitFor(
      'main2 to recover the foreground command from ptyd',
      () => main2.cache.getFg(paneId) === fgBefore,
    );
    await waitFor(
      'main2 to recover attention from ptyd',
      () => main2.cache.getAttention(paneId) === true,
    );

    // And the value that actually reaches the nav: a pane whose bell is still
    // ringing is `blocked`, not `idle`. This is the assertion the user sees.
    const row = new PaneStore(db).getById(paneId);
    if (!row) throw new Error('pane row vanished');
    expect(decoratePane(main2.cache, row).status).toBe('blocked');

    db.close();
  }, 40_000);
});
