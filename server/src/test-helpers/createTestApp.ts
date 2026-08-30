import type { UrlHealth } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import type { AgentBridge } from '../agent-bridge.js';
import { type AppRegistry, createAppRegistry } from '../apps/AppRegistry.js';
import { createAppStatusProbe } from '../apps/AppStatus.js';
import type { ArchiveDb } from '../archive/ArchiveDb.js';
import type { EventBus } from '../events.js';
import type { Funnel } from '../funnel.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import type { TabActivity } from '../tab-activity.js';
import { type SpawnedPtyd, spawnPtyd } from './spawnPtyd.js';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  ptyd: SpawnedPtyd;
  cache: PtydCache;
  /** The registry backing /api/apps, when `apps` was requested. */
  registry?: AppRegistry;
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
  /** Shared per-tab activity recorder (the living sidebar's recency signal). */
  tabActivity?: TabActivity;
  /**
   * Mount a LIVE app registry on /api/apps, backed by the same real ptyd.
   * `probe` stands in for the URL health check so a route test never depends on
   * something actually listening on a port; omit it and every app reads
   * `starting`.
   */
  apps?: { probe?: (url: string) => Promise<UrlHealth>; gaveUp?: (paneId: string) => boolean };
}): Promise<TestApp> {
  const ptyd = await spawnPtyd();
  const cache = new PtydCache();
  cache.attach(ptyd.client);
  const registry = opts.apps
    ? createAppRegistry({ db: opts.db, ptyd: ptyd.client, defaultShell: '/bin/cat', log: () => {} })
    : undefined;
  const status =
    opts.apps &&
    createAppStatusProbe({
      db: opts.db,
      ptyd: ptyd.client,
      ttlMs: 0,
      ...(opts.apps.probe ? { probe: opts.apps.probe } : {}),
      ...(opts.apps.gaveUp ? { gaveUp: opts.apps.gaveUp } : {}),
    });
  const app = createApp({
    db: opts.db,
    ptyd: ptyd.client,
    cache,
    dataDir: opts.dataDir,
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.agentBridge ? { agentBridge: opts.agentBridge } : {}),
    ...(opts.archive ? { archive: opts.archive } : {}),
    ...(opts.publish ? { publish: opts.publish } : {}),
    ...(opts.tabActivity ? { tabActivity: opts.tabActivity } : {}),
    ...(registry ? { apps: { registry, ...(status ? { status } : {}) } } : {}),
  });
  return {
    app,
    ptyd,
    cache,
    ...(registry ? { registry } : {}),
    async cleanup() {
      await ptyd.cleanup();
    },
  };
}
