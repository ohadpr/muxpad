import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { randomWorkspaceName } from '../random-name.js';

/**
 * CRUD for the top-level workspace concept. Workspaces own tabs; tabs
 * own panes. Lives at /api/workspaces; tab routes live at /api/tabs.
 */
export function workspacesRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();
  const workspaces = new WorkspaceStore(deps.db);

  app.get('/', (c) => c.json(workspaces.list()));

  app.post('/', async (c) => {
    const body = z
      .object({ name: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const name = body.name?.trim() || randomWorkspaceName();
    return c.json(workspaces.create({ name }), 201);
  });

  app.get('/:id', (c) => {
    const w = workspaces.getById(c.req.param('id'));
    if (!w)
      return c.json(
        { error: { code: 'not_found', message: 'workspace not found' } },
        404,
      );
    return c.json(w);
  });

  app.patch('/:id', async (c) => {
    const body = z
      .object({ name: z.string().optional(), slug: z.string().optional() })
      .parse(await c.req.json());
    try {
      return c.json(workspaces.update(c.req.param('id'), body));
    } catch {
      return c.json(
        { error: { code: 'not_found', message: 'workspace not found' } },
        404,
      );
    }
  });

  /**
   * Refuses to delete a workspace that still has tabs. The empty-tabs
   * case is the only legitimate path to deletion (mirrors the existing
   * "you can only close an empty tab" UX pattern).
   */
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const w = workspaces.getById(id);
    if (!w)
      return c.json(
        { error: { code: 'not_found', message: 'workspace not found' } },
        404,
      );
    if (w.tab_count > 0) {
      return c.json(
        {
          error: {
            code: 'workspace_not_empty',
            message: `workspace still has ${w.tab_count} tab(s)`,
          },
        },
        409,
      );
    }
    workspaces.delete(id);
    return c.body(null, 204);
  });

  app.post('/reorder', async (c) => {
    const body = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
    workspaces.reorder(body.ids);
    return c.body(null, 204);
  });

  return app;
}
