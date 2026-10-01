import { expect, it } from 'vitest';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { panesScopedRoutes } from './routes/panes.js';
import { PaneStore } from './store/PaneStore.js';
import { SpawnRoundStore } from './store/SpawnRoundStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { clockIndex, resolveTabClock } from './tab-clock.js';

it.each(['child', 'pinned child', 'remaining agent', 'root'])(
  'deleting the last supervised pane settles only orphan work: %s',
  async (shape) => {
    const db = openDb(':memory:');
    try {
      const tabs = new TabStore(db);
      const panes = new PaneStore(db);
      const rounds = new SpawnRoundStore(db);
      const workspace = new WorkspaceStore(db).create({ name: 'W' });
      const parent = tabs.create({ name: 'Parent', workspace_id: workspace.id, layout: '' });
      const child = tabs.create({
        name: 'Child',
        workspace_id: workspace.id,
        layout: '',
        ...(shape !== 'root' ? { spawned_by: parent.id } : {}),
      });
      if (shape === 'pinned child') tabs.setPinned(child.id, true);
      const pane = panes.create({ tab_id: child.id, startup_cmd: 'muxpad agent' });
      tabs.update(child.id, { layout: pane.id });
      if (shape === 'remaining agent')
        panes.create({ tab_id: child.id, startup_cmd: 'muxpad agent' });
      rounds.open(child.id);
      const app = panesScopedRoutes({
        db,
        events: new EventBus(),
        cache: new PtydCache(),
        ptyd: { killPane: async () => {} } as unknown as PtydClient,
      });
      expect((await app.request(`/${pane.id}`, { method: 'DELETE' })).status).toBe(204);
      expect(panes.getById(pane.id)).toBeNull();
      const orphan = shape === 'child' || shape === 'pinned child';
      expect(rounds.openRound(child.id) === null).toBe(orphan);
      const state = resolveTabClock(clockIndex(db), child.id, Date.now());
      expect(state.done).toBe(shape === 'child');
      if (shape === 'child') expect(state.done_reason).toBe('died');
    } finally {
      db.close();
    }
  },
);
