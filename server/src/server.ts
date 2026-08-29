import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { AgentBridge } from './agent-bridge.js';
import type { ArchiveDb } from './archive/ArchiveDb.js';
import { EventBus } from './events.js';
import { type Funnel, localFunnel } from './funnel.js';
import type { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import type { Presence, PushService } from './push.js';
import { agentSessionsRoutes } from './routes/agent-sessions.js';
import { attachmentsRoutes } from './routes/attachments.js';
import { ceoRoutes } from './routes/ceo.js';
import { eventsRoutes } from './routes/events.js';
import { openRoutes } from './routes/open.js';
import { paneIoRoutes } from './routes/pane-io.js';
import { panesScopedRoutes, panesTabScopedRoutes } from './routes/panes.js';
import { publishRoutes } from './routes/publish.js';
import { pushRoutes } from './routes/push.js';
import { archiveRoutes, searchRoutes } from './routes/search.js';
import { summaryRoutes } from './routes/summary.js';
import { tabsRoutes } from './routes/tabs.js';
import { workspacesRoutes } from './routes/workspaces.js';

export interface AppDeps {
  db: Database.Database;
  /**
   * Connected ptyd control client. The route layer issues control RPCs
   * (ensurePane, killPane, markSeen, closePtyClients) against this — no
   * PaneRuntime lives on the main server anymore.
   */
  ptyd: PtydClient;
  /**
   * Per-pane decoration cache populated from ptyd push events. The HTTP
   * handlers read this synchronously (workspace lists, tab GET, cwd-
   * inherit-from-sibling) instead of round-tripping to ptyd per request.
   */
  cache: PtydCache;
  dataDir: string;
  /**
   * In-process pub/sub for structural state-change events. Routes emit
   * here after a successful mutation; the /ws/events upgrade arm
   * (server/src/ws.ts) fans the events out to subscribed browsers.
   * Optional in `AppDeps` so tests that don't care about events can omit
   * it — `createApp` materialises a bus locally in that case.
   */
  events?: EventBus;
  /**
   * Late-bound relay into the ws layer's agent-runner registry (see
   * agent-bridge.ts). Optional so HTTP-only tests can omit it — the send
   * route then reports the agent as unavailable.
   */
  agentBridge?: AgentBridge;
  /**
   * Web Push subscriptions + delivery (see push.ts). Optional so tests
   * that don't exercise notifications can omit it — the /api/push routes
   * simply aren't mounted then.
   */
  push?: PushService;
  /**
   * Client active-device heartbeat sink. POST /api/presence marks it; the
   * pane notifier holds pushes while it reads active. Optional (tests / no
   * push).
   */
  presence?: Presence;
  /**
   * Session-archive index (`archive.sqlite`, see archive/). Optional so
   * tests that don't exercise search can omit it — /api/search and
   * /api/archive simply aren't mounted then.
   */
  archive?: ArchiveDb;
  /**
   * Publish deps (routes/publish.ts): the funnel manager that ensures the
   * public Tailscale Funnel on publish. Optional so tests can omit it — the
   * routes are still mounted, backed by a localFunnel that NEVER execs
   * tailscale (nothing a test does can expose content publicly).
   */
  publish?: { funnel: Funnel; publicPort?: number };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // Default to a bus that has zero subscribers; emissions become no-ops.
  // Keeps the route-level emit() calls type-clean without forcing every
  // test harness (or the WS-less HTTP smoke tests) to construct one.
  const resolved = { ...deps, events: deps.events ?? new EventBus() };
  app.get('/api/health', (c) => c.json({ ok: true }));
  // Active-device heartbeat: the web app POSTs this while foregrounded and
  // interacted-with, so push notifications hold off while you're at a device.
  app.post('/api/presence', (c) => {
    resolved.presence?.mark();
    return c.body(null, 204);
  });
  app.route('/api/workspaces', workspacesRoutes(resolved));
  app.route('/api/tabs', tabsRoutes(resolved));
  app.route('/api/tabs', panesTabScopedRoutes(resolved));
  app.route('/api/panes', panesScopedRoutes(resolved));
  app.route('/api/panes', paneIoRoutes(resolved));
  app.route('/api/panes', attachmentsRoutes(resolved));
  app.route('/api/panes', summaryRoutes(resolved));
  app.route('/api/open', openRoutes(resolved));
  // SSE mirror of /ws/events — curl-able subscription for scripts/agents.
  app.route('/api/events', eventsRoutes(resolved));
  // The singleton CEO pane — ensure + resolve its ids.
  app.route('/api/ceo', ceoRoutes(resolved));
  app.route('/api/agent-sessions', agentSessionsRoutes(resolved));
  // Artifact publishing (copies into <dataDir>/public, served by the separate
  // public-port app). Default funnel is exec-free — see AppDeps.publish.
  app.route(
    '/api/publish',
    publishRoutes({
      db: resolved.db,
      dataDir: resolved.dataDir,
      funnel:
        resolved.publish?.funnel ??
        localFunnel(resolved.publish?.publicPort ?? 7778, 'funnel not configured'),
    }),
  );
  if (resolved.push) app.route('/api/push', pushRoutes(resolved.push));
  if (resolved.archive) {
    const archiveDeps = { db: resolved.db, archive: resolved.archive };
    app.route('/api/search', searchRoutes(archiveDeps));
    app.route('/api/archive', archiveRoutes(archiveDeps));
  }
  return app;
}
