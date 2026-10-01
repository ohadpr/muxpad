import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createAgentBridge } from './agent-bridge.js';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { RESPAWN_COOLDOWN_MS, RESPAWN_MAX_ATTEMPTS } from './respawn-policy.js';
import { PaneStore } from './store/PaneStore.js';
import { SpawnRoundStore } from './store/SpawnRoundStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { clockIndex, resolveTabClock } from './tab-clock.js';
import { ChatRetirer } from './tab-retire.js';
import { attachWsServer } from './ws.js';

it('a rejected send after give-up records attention without reviving the child or opening a round', async () => {
  const db = openDb(':memory:');
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  const rounds = new SpawnRoundStore(db);
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
  rounds.open(child.id);
  const cache = new PtydCache();
  const events = new EventBus();
  const retirer = new ChatRetirer({ db, cache, events });
  const bridge = createAgentBridge();
  const http = createServer();
  const ptyd = {
    on: () => {},
    getForegroundCommand: async () => null,
    killPane: async () => {},
    ensurePane: async () => {},
  } as unknown as PtydClient;
  const server = attachWsServer({
    http,
    db,
    ptyd,
    cache,
    events,
    agentBridge: bridge,
    onRunnerDead: (id) => {
      retirer.onRunnerDead(id);
    },
  });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (let i = 0; i <= RESPAWN_MAX_ATTEMPTS; i++) {
      now += RESPAWN_COOLDOWN_MS + 1;
      await server.sweepDeadRunners();
    }
    expect(resolveTabClock(clockIndex(db), child.id, now).done_reason).toBe('died');
    expect(rounds.openRound(child.id)).toBeNull();
    now += 1;
    expect(bridge.submitSend(pane.id, 'try again').status).toBe('rejected');
    expect(tabs.getById(child.id)?.last_activity_at).toBe(now);
    expect(rounds.openRound(child.id)).toBeNull();
    expect(resolveTabClock(clockIndex(db), child.id, now).done_reason).toBe('died');
    // After the sweep forgets the give-up, accepted durable work DOES revive.
    await server.sweepDeadRunners();
    expect(bridge.submitSend(pane.id, 'new job').status).toBe('queued');
    expect(rounds.openRound(child.id)).not.toBeNull();
    expect(resolveTabClock(clockIndex(db), child.id, now).done).toBe(false);
  } finally {
    clock.mockRestore();
    retirer.stop();
    await server.close();
    db.close();
  }
});
