import { describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import { PtydCache } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { workspacesRoutes } from './routes/workspaces.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

/**
 * A CAPABILITY MUST NOT BE SELF-GRANTABLE.
 *
 * Instructions are prose and an agent may usefully maintain them, so the CLI
 * writes them. The Slack switch is permission, and the CLI is what AGENTS
 * drive — an agent that can turn Slack on for its own workspace makes the whole
 * Slack guard decoration. The available distinction is the one same-origin.ts
 * already draws: a browser attaches `Origin`, the CLI and the agent runner do
 * not.
 */
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

describe('PATCH /api/workspaces/:id', () => {
  it('refuses a capability change with no browser Origin', async () => {
    const { ws, app, store } = harness();
    const r = await app.request(`/${ws.id}`, patch({ slack: true }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('ui_only');
    expect(store.getById(ws.id)?.slack).toBeFalsy();
  });

  it('accepts it from the UI', async () => {
    const { ws, app, store } = harness();
    const r = await app.request(`/${ws.id}`, patch({ slack: true }, 'http://localhost:7777'));
    expect(r.status).toBe(200);
    expect(store.getById(ws.id)?.slack).toBe(true);
  });

  it('takes instructions from ANY caller — prose is not permission', async () => {
    const { ws, app, store } = harness();
    const r = await app.request(`/${ws.id}`, patch({ instructions: 'pnpm, never prod' }));
    expect(r.status).toBe(200);
    expect(store.getById(ws.id)?.instructions).toBe('pnpm, never prod');
  });

  it('clears instructions on empty string', async () => {
    const { ws, app, store } = harness();
    await app.request(`/${ws.id}`, patch({ instructions: 'x' }));
    await app.request(`/${ws.id}`, patch({ instructions: '' }));
    expect(store.getById(ws.id)?.instructions).toBeNull();
  });

  /**
   * `update()` composes its return value from the row it read on the way IN,
   * which is before the instructions and capability writes land. Returning it
   * reported the old values, and the panel renders the response — so a freshly
   * flipped toggle flipped back on save.
   */
  it('returns the row as it is AFTER the write, not before', async () => {
    const { ws, app } = harness();
    const r = await app.request(
      `/${ws.id}`,
      patch({ slack: true, instructions: 'now' }, 'http://localhost:7777'),
    );
    const body = (await r.json()) as { slack?: boolean | number; instructions?: string };
    expect(body.instructions).toBe('now');
    expect(body.slack).toBeTruthy();
  });
});

describe('GET /api/workspaces/:id/agent-instructions', () => {
  it('is composed by the same function the backends call', async () => {
    // Not re-derived in the panel: the preview has to be the thing, or it is a
    // second place deriving one value — the defect this codebase keeps paying
    // for. Proof here is that the workspace's own text comes back in it.
    const { ws, app } = harness();
    await app.request(`/${ws.id}`, patch({ instructions: 'MARKER-ab12' }));
    const r = await app.request(`/${ws.id}/agent-instructions`);
    expect(r.status).toBe(200);
    expect((await r.json()).text).toContain('MARKER-ab12');
  });

  it('404s for a workspace that is not there', async () => {
    const { app } = harness();
    expect((await app.request('/nope/agent-instructions')).status).toBe(404);
  });
});
