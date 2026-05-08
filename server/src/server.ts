import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { PaneManager } from './runtime/PaneManager.js';
import { workspacesRoutes } from './routes/workspaces.js';
import { panesWorkspaceScopedRoutes, panesScopedRoutes } from './routes/panes.js';
import { attachmentsRoutes } from './routes/attachments.js';

export interface AppDeps {
  db: Database.Database;
  paneManager: PaneManager;
  dataDir: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/workspaces', workspacesRoutes(deps));
  app.route('/api/workspaces', panesWorkspaceScopedRoutes(deps));
  app.route('/api/panes', panesScopedRoutes(deps));
  app.route('/api/panes', attachmentsRoutes(deps));
  return app;
}
