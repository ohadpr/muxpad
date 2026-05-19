import { createApp } from '../server.js';
import { PtydCache } from '../ptyd-cache.js';
import { spawnPtyd, type SpawnedPtyd } from './spawnPtyd.js';
import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';

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
