import type Database from 'better-sqlite3';
import type { AgentBridge } from '../agent-bridge.js';
import type { ArchiveDb } from '../archive/ArchiveDb.js';
import type { EventBus } from '../events.js';
import type { Funnel } from '../funnel.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { type SpawnedPtyd, spawnPtyd } from './spawnPtyd.js';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  ptyd: SpawnedPtyd;
  cache: PtydCache;
  cleanup(): Promise<void>;
}

/**
 * Standard test setup: an in-process ptyd, a connected PtydClient, a
 * PtydCache attached to it, and a Hono app wired through them. Existing
 * route tests use this to replace `new PaneManager()` + direct createApp
 * construction with one async call.
 */
export async function createTestApp(opts: {
  db: Database.Database;
  dataDir: string;
  events?: EventBus;
  agentBridge?: AgentBridge;
  /** Mounts /api/search + /api/archive when provided (archive e2e tests). */
  archive?: ArchiveDb;
  /** Funnel stub for /api/publish tests — never a real tailscale exec. */
  publish?: { funnel: Funnel };
}): Promise<TestApp> {
  const ptyd = await spawnPtyd();
  const cache = new PtydCache();
  cache.attach(ptyd.client);
  const app = createApp({
    db: opts.db,
    ptyd: ptyd.client,
    cache,
    dataDir: opts.dataDir,
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.agentBridge ? { agentBridge: opts.agentBridge } : {}),
    ...(opts.archive ? { archive: opts.archive } : {}),
    ...(opts.publish ? { publish: opts.publish } : {}),
  });
  return {
    app,
    ptyd,
    cache,
    async cleanup() {
      await ptyd.cleanup();
    },
  };
}
