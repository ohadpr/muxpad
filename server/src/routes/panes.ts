import { Hono } from 'hono';
import { z } from 'zod';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { PaneStore } from '../store/PaneStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import type { PaneManager } from '../runtime/PaneManager.js';

const defaultShell = process.env.SHELL ?? '/bin/zsh';

export function panesWorkspaceScopedRoutes(deps: {
  db: Database.Database;
  paneManager: PaneManager;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);
  const workspaces = new WorkspaceStore(deps.db);

  app.post('/:id/panes', async (c) => {
    const wsId = c.req.param('id');
    const ws = workspaces.getById(wsId);
    if (!ws)
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    const body = z
      .object({
        shell: z.string().optional(),
        startup_cmd: z.string().nullable().optional(),
        cwd: z.string().optional(),
        env: z.record(z.string()).nullable().optional(),
        inherit_cwd_from: z.string().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));

    // cwd resolution order: explicit `cwd` wins → else inherit from a sibling
    // pane's *current* shell cwd → else that sibling's stored spawn cwd → else
    // homedir.
    let cwd = body.cwd;
    if (!cwd && body.inherit_cwd_from) {
      const source = panes.getById(body.inherit_cwd_from);
      if (source && source.workspace_id === wsId) {
        const live = deps.paneManager.get(source.id)?.getCurrentCwd();
        cwd = live ?? source.cwd;
      }
    }

    const pane = panes.create({
      workspace_id: wsId,
      shell: body.shell ?? defaultShell,
      cwd: cwd ?? homedir(),
      startup_cmd: body.startup_cmd ?? null,
      env: body.env ?? null,
    });
    return c.json(pane, 201);
  });

  return app;
}

export function panesScopedRoutes(deps: {
  db: Database.Database;
  paneManager: PaneManager;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);

  app.get('/:id', (c) => {
    const p = panes.getById(c.req.param('id'));
    if (!p)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    return c.json({ ...p, isRunning: deps.paneManager.has(p.id) });
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    await deps.paneManager.kill(id);
    panes.delete(id);
    return c.body(null, 204);
  });

  app.post('/:id/respawn', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    await deps.paneManager.kill(id);
    deps.paneManager.getOrCreate({
      id: p.id,
      shell: p.shell,
      startup_cmd: p.startup_cmd,
      cwd: p.cwd,
      env: p.env,
    });
    return c.body(null, 204);
  });

  return app;
}
