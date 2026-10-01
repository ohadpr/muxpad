import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { attachWsServer } from './ws.js';

it.each(['deleted', 'archived', 'converted'])(
  'does not resurrect a worker %s while its restart kill was pending',
  async (change) => {
    const db = openDb(':memory:');
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    const workspace = new WorkspaceStore(db).create({ name: 'W' });
    const parent = tabs.create({ name: 'Parent', workspace_id: workspace.id, layout: '' });
    const child = tabs.create({
      name: 'Child',
      workspace_id: workspace.id,
      layout: '',
      spawned_by: parent.id,
    });
    const pane = panes.create({ tab_id: child.id, startup_cmd: 'muxpad agent', cwd: '/tmp' });
    db.prepare('UPDATE panes SET created_at = 1 WHERE id = ?').run(pane.id);
    let finishKill!: () => void;
    let reachedKill!: () => void;
    const killing = new Promise<void>((resolve) => {
      reachedKill = resolve;
    });
    const ensured: unknown[] = [];
    const ptyd = {
      on: () => {},
      getForegroundCommand: async () => null,
      killPane: () =>
        new Promise<void>((resolve) => {
          finishKill = resolve;
          reachedKill();
        }),
      ensurePane: async (spec: unknown) => {
        ensured.push(spec);
      },
    } as unknown as PtydClient;
    const server = attachWsServer({
      http: createServer(),
      db,
      ptyd,
      cache: new PtydCache(),
      events: new EventBus(),
    });
    try {
      const sweep = server.sweepDeadRunners();
      await killing;
      if (change === 'deleted') panes.delete(pane.id);
      if (change === 'archived') tabs.retire(child.id, 'archived');
      if (change === 'converted') panes.setStartupCmd(pane.id, null);
      finishKill();
      await sweep;
      expect(ensured).toEqual([]);
    } finally {
      await server.close();
      db.close();
    }
  },
);
