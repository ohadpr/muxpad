import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { ensureCeoPane } from '../ceo.js';
import type { EventBus } from '../events.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';

/**
 * GET /api/ceo → { pane_id, tab_id, workspace_slug, tab_slug } — resolve
 * (ensuring, if needed) the singleton CEO pane, so clients and the CLI never
 * hard-code ids. The slugs let the web app route the CEO through the normal
 * /w/:ws/t/:tab surface (pinned sidebar row + the /ceo redirect).
 */
export function ceoRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  events: EventBus;
  dataDir: string;
}): Hono {
  const app = new Hono();
  app.get('/', async (c) => c.json(await ensureCeoPane(deps)));
  return app;
}
