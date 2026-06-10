/**
 * Minimal muxpad stack for Cursor scroll e2e tests.
 * Writes e2e/.runtime.json and listens until SIGTERM.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/src/store/db.js';
import { PaneStore } from '../server/src/store/PaneStore.js';
import { TabStore } from '../server/src/store/TabStore.js';
import { WorkspaceStore } from '../server/src/store/WorkspaceStore.js';
import { attachWsServer } from '../server/src/ws.js';
import { EventBus } from '../server/src/events.js';
import { spawnPtyd } from '../server/src/test-helpers/spawnPtyd.js';

const here = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(here, '.runtime.json');

async function main() {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const ws = workspaces.create({ name: 'e2e' });
  const tab = tabs.create({ name: 'scroll', layout: 'p1', workspace_id: ws.id });
  const sim = join(here, 'cursor-sim.mjs');
  const pane = panes.create({
    tab_id: tab.id,
    shell: '/bin/sh',
    cwd: '/tmp',
    startup_cmd: `node ${sim}`,
  });

  const http = createServer();
  attachWsServer({ http, db, ptyd: ptyd.client, events: new EventBus() });
  const port = Number(process.env.MUXPAD_E2E_PORT ?? 7878);
  await new Promise<void>((r) => http.listen(port, '127.0.0.1', () => r()));

  writeFileSync(runtimePath, JSON.stringify({ port, paneId: pane.id }, null, 2));
  console.log(`[e2e bootstrap] http://127.0.0.1:${port} pane=${pane.id}`);

  const shutdown = async () => {
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
