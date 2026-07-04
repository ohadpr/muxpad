import { mkdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { PtydCache, decoratePane } from './ptyd-cache.js';
import { PtydClient } from './ptyd-client/PtydClient.js';
import { createApp } from './server.js';
import { PaneStore } from './store/PaneStore.js';
import { openDb } from './store/db.js';
import { attachWsServer } from './ws.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'db.sqlite'));
const paneStore = new PaneStore(db);
// EventBus is shared by the route layer (HTTP-driven mutations) and the
// /ws/events upgrade arm (server/src/ws.ts) which fans events out to
// subscribed browsers.
const events = new EventBus();

// Connect to the (separately-managed) ptyd daemon. The main server no
// longer owns PTYs — it issues control RPCs and bridges WSes through
// proxyAttach. ptyd lifecycle (start/restart/launchd) is independent.
const ptyd = new PtydClient({ socketPath: config.ptydSocketPath });
const cache = new PtydCache();
cache.attach(ptyd);
// Prime the cache with last-known cwds from SQLite so handlers that read
// cache.getCwd() during the window between HTTP-start and ptyd's first
// `connected → flushCwds()` reply don't see null. A real event from ptyd
// supersedes the seed (seedCwds skips already-present ids).
cache.seedCwds(paneStore.listCwds());

// Persist cwds as ptyd reports them, so respawning a pane after a daemon
// restart lands in the shell's actual cwd instead of the spawn cwd.
ptyd.on('paneCwd', (e: { id: string; cwd: string }) => {
  paneStore.updateCwd(e.id, e.cwd);
});

// Whenever any of (title, fg, attention, busy) changes for a pane, push a
// decorated `pane.updated` event on the EventBus so /ws/events
// subscribers see the diff. The cache emits a single 'paneChange' per
// field-mutation; we rebuild the full decorated row from the cache + db.
cache.on('paneChange', (paneId: string) => {
  const pane = paneStore.getById(paneId);
  if (!pane) return;
  events.emit({
    type: 'pane.updated',
    tab_id: pane.tab_id,
    pane: decoratePane(cache, pane),
  });
});

const app = createApp({
  db,
  ptyd,
  cache,
  dataDir: config.dataDir,
  events,
});

// Static asset serving (CSS, JS, images, etc.) from the built web bundle.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web', 'dist');

// The HTML shell must be served `no-cache` so the browser ALWAYS revalidates it
// and picks up a rebuilt bundle's new hashed asset names. Assets themselves are
// content-hashed (immutable) and keep serveStatic's cacheable headers — only the
// index.html entrypoint is the stale-after-rebuild trap. Without this, a reload
// can keep serving an old index.html that references the pre-rebuild CSS/JS.
const serveIndexHtml = (c: Context) => {
  c.header('Cache-Control', 'no-cache');
  try {
    return c.html(readFileSync(join(webRoot, 'index.html'), 'utf-8'));
  } catch {
    return c.text('not found', 404);
  }
};
app.get('/', serveIndexHtml);
// Direct /index.html requests must not slip through to serveStatic either —
// that would hand the shell back with cacheable headers, the exact trap the
// no-cache route exists to close.
app.get('/index.html', serveIndexHtml);

app.use('/*', serveStatic({ root: webRoot }));

// Anything that fell through both API routes and static files lands here.
// API/WS paths return JSON 404 so the client can parse them; everything else
// is treated as a client-side SPA route and gets index.html.
//
// Read index.html fresh on each fallback request — caching it in memory means
// a rebuild that produces a new hashed bundle name still serves the old HTML,
// which then 404s on its asset references. The file is ~1KB and the SPA
// fallback is rare relative to static-asset hits, so the cost is negligible.
//
// Asset paths (/assets/*) and any path with a file extension must NEVER fall
// back to index.html — serving HTML with a JS or CSS Content-Type triggers
// the browser's MIME-type sniffing and breaks module loading. Those return
// a real 404 instead.
app.notFound((c) => {
  const path = c.req.path;
  if (path.startsWith('/api/') || path.startsWith('/ws/')) {
    return c.json({ error: { code: 'not_found', message: 'route not found' } }, 404);
  }
  if (path.startsWith('/assets/') || /\.[a-zA-Z0-9]+$/.test(path)) {
    return c.text('not found', 404);
  }
  // SPA client route (e.g. /w/:ws/t/:tab) → the no-cache HTML shell.
  return serveIndexHtml(c);
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`muxpad listening on http://${info.address}:${info.port}`);
});

const httpServer = server as unknown as Server;
const wsServer = attachWsServer({ http: httpServer, db, ptyd, cache, events });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down…');
  // Close browser-facing WSes first so they don't see ptyd's `close` (which
  // is going to follow as we disconnect the control channel) as a PTY-exit.
  //
  // IMPORTANT: `wsServer.close()` uses `terminate()` (not `ws.close(1000)`)
  // on remaining clients, which surfaces as a 1006 abnormal close on the
  // browser. The client treats 1006 as transient (its reconnect path
  // re-attaches when the server comes back) rather than as a natural shell
  // exit. Do NOT "clean this up" to `close(1000)` — the client would
  // interpret 1000 as the shell having exited and DELETE the pane from the
  // layout. The asymmetry is load-bearing.
  await wsServer.close();
  // Disconnect from ptyd. CRITICALLY we do NOT call killAll — that is
  // precisely the point of the split. ptyd outlives the main server and
  // keeps PTYs warm across main-server restarts.
  await ptyd.close();
  // Force keep-alive HTTP sockets to drop so server.close()'s callback fires.
  httpServer.closeAllConnections();
  httpServer.close(() => process.exit(0));
  // Belt-and-suspenders: hard exit if anything still pins the loop after 5s.
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
