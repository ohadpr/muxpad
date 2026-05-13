import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { LayoutNodeSchema } from '@muxpad/shared';
import { TabStore } from '../store/TabStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { pruneDeadPanes } from '../store/migrations.js';
import type { PaneManager } from '../runtime/PaneManager.js';
import { randomWorkspaceName } from '../random-name.js';

/**
 * CRUD for tabs (the things in the tab bar). Each tab belongs to a
 * parent workspace. List queries are scoped via `?workspaceId=…`.
 */
export function tabsRoutes(deps: {
  db: Database.Database;
  paneManager: PaneManager;
}): Hono {
  const app = new Hono();
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);

  app.post('/', async (c) => {
    const body = z
      .object({
        workspace_id: z.string(),
        name: z.string().optional(),
        layout: LayoutNodeSchema.optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const name = body.name?.trim() || randomWorkspaceName();
    const t = tabs.create({
      name,
      layout: body.layout ?? '',
      workspace_id: body.workspace_id,
    });
    return c.json(t, 201);
  });

  app.get('/', (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) {
      return c.json(
        { error: { code: 'bad_request', message: 'workspaceId query param required' } },
        400,
      );
    }
    const list = tabs.listByWorkspace(workspaceId);
    // Fold in per-tab attention flag from the live PaneManager. A tab
    // flags as needing attention if any of its panes has rung BEL since
    // the user last interacted with it. Panes whose runtime isn't
    // running (lazy-spawn, no client connected) contribute false.
    const decorated = list.map((t) => {
      const tabPanes = panes.listByTab(t.id);
      const attention = tabPanes.some(
        (p) => deps.paneManager.get(p.id)?.getNeedsAttention() ?? false,
      );
      return { ...t, attention };
    });
    return c.json(decorated);
  });

  // Mark every pane in a tab as "seen". Called by the web client when
  // the user navigates to a tab — counts as an interaction so the tab
  // attention dot doesn't reappear if they leave without typing.
  app.post('/:id/seen', (c) => {
    const id = c.req.param('id');
    for (const p of panes.listByTab(id)) {
      deps.paneManager.get(p.id)?.markSeen();
    }
    return c.body(null, 204);
  });

  app.post('/reorder', async (c) => {
    const body = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
    tabs.reorder(body.ids);
    return c.body(null, 204);
  });

  app.get('/:id', (c) => {
    const t = tabs.getById(c.req.param('id'));
    if (!t)
      return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    const livePanes = panes.listByTab(t.id);
    const valid = new Set(livePanes.map((p) => p.id));
    const cleaned = pruneDeadPanes(t.layout, valid);
    if (JSON.stringify(cleaned) !== JSON.stringify(t.layout)) {
      tabs.update(t.id, { layout: cleaned });
      t.layout = cleaned;
    }
    const decorated = livePanes.map((p) => ({
      ...p,
      title: deps.paneManager.get(p.id)?.getCurrentTitle() ?? null,
      foreground_cmd: deps.paneManager.getForegroundCommand(p.id),
    }));
    return c.json({ ...t, panes: decorated });
  });

  app.patch('/:id', async (c) => {
    const body = z
      .object({
        name: z.string().optional(),
        slug: z.string().optional(),
        layout: LayoutNodeSchema.optional(),
      })
      .parse(await c.req.json());
    try {
      const t = tabs.update(c.req.param('id'), body);
      return c.json(t);
    } catch {
      return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    }
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const t = tabs.getById(id);
    if (!t)
      return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    for (const p of panes.listByTab(id)) {
      await deps.paneManager.kill(p.id);
    }
    tabs.delete(id);
    return c.body(null, 204);
  });

  return app;
}
