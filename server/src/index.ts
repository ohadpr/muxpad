import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { openDb } from './store/db.js';
import { PaneManager } from './runtime/PaneManager.js';
import { PaneStore } from './store/PaneStore.js';
import { attachWsServer } from './ws.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'db.sqlite'));
const paneStore = new PaneStore(db);
// Periodically snapshot each running pane's actual cwd so that on daemon
// restart the shell respawns where the user actually was, not the directory
// the pane was created in.
const paneManager = new PaneManager({
  onCwdChange: (paneId, cwd) => paneStore.updateCwd(paneId, cwd),
});
const app = createApp({ db, paneManager, dataDir: config.dataDir });

// Static asset serving (CSS, JS, images, etc.) from the built web bundle.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web', 'dist');
app.use('/*', serveStatic({ root: webRoot }));

// Anything that fell through both API routes and static files lands here.
// API/WS paths return JSON 404 so the client can parse them; everything else
// is treated as a client-side SPA route and gets index.html.
let cachedIndexHtml: string | null = null;
const readIndex = (): string => {
  if (!cachedIndexHtml) cachedIndexHtml = readFileSync(join(webRoot, 'index.html'), 'utf-8');
  return cachedIndexHtml;
};
app.notFound((c) => {
  const path = c.req.path;
  if (path.startsWith('/api/') || path.startsWith('/ws/')) {
    return c.json({ error: { code: 'not_found', message: 'route not found' } }, 404);
  }
  try {
    return c.html(readIndex());
  } catch {
    return c.text('not found', 404);
  }
});

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(`muxpad listening on http://${info.address}:${info.port}`);
  },
);

const httpServer = server as unknown as Server;
const wsServer = attachWsServer({ http: httpServer, db, paneManager });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down…');
  // CRITICAL ORDERING: close WSs first so the bridge's 'close' handler
  // detaches runtime listeners *before* we kill the PTYs. Otherwise killAll
  // makes each runtime emit 'exit', the bridge dispatches an exit frame to
  // every connected client, and clients interpret that as "the shell exited
  // naturally" → delete the pane row. Net effect of the wrong order: a
  // daemon restart wipes panes from every open workspace.
  // Snapshot current cwds before tearing PTYs down, so a graceful shutdown
  // captures the very latest directory every pane was in (not just the last
  // periodic poll, which could be up to 30s stale).
  paneManager.flushCwds();
  await wsServer.close();
  await paneManager.killAll();
  // Force keep-alive HTTP sockets to drop so server.close()'s callback fires.
  httpServer.closeAllConnections();
  httpServer.close(() => process.exit(0));
  // Belt-and-suspenders: hard exit if anything still pins the loop after 5s.
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
