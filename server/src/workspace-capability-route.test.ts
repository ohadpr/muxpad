import { describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { workspacesRoutes } from './routes/workspaces.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

function harness() {
  const db = openDb(':memory:');
  const store = new WorkspaceStore(db);
  const ws = store.create({ name: 'W' });
  const app = workspacesRoutes({
    db,
    events: new EventBus(),
    cache: new PtydCache(),
    ptyd: {} as unknown as PtydClient,
  });
  return { db, store, ws, app };
}

const patch = (body: unknown, origin?: string) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify(body),
});

describe('workspace metadata only', () => {
  it.each([{ slack: true }, { instructions: 'retired' }])(
    'rejects retired settings %j without changing stored data',
    async (body) => {
      const { app, ws, db } = harness();
      const response = await app.request(`/${ws.id}`, patch(body));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('invalid_request');
      expect(
        db.prepare('SELECT instructions, slack FROM workspaces WHERE id = ?').get(ws.id),
      ).toEqual({ instructions: null, slack: 0 });
      db.close();
    },
  );
  it('keeps rename available without returning retired settings', async () => {
    const { app, ws, store, db } = harness();
    db.prepare('UPDATE workspaces SET instructions = ?, slack = 0 WHERE id = ?').run(
      'OLD WORKSPACE PROMPT',
      ws.id,
    );
    const r = await app.request(`/${ws.id}`, patch({ name: 'Renamed' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: 'Renamed' });
    expect(store.getById(ws.id)).not.toHaveProperty('slack');
    expect(store.getById(ws.id)).not.toHaveProperty('instructions');
    const read = await app.request(`/${ws.id}`);
    const body = await read.json();
    expect(body).not.toHaveProperty('slack');
    expect(body).not.toHaveProperty('instructions');
    expect((await app.request(`/${ws.id}/agent-instructions`)).status).toBe(404);
    db.close();
  });
});
