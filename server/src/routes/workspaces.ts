import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { LayoutNodeSchema } from '@muxpad/shared';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { pruneDeadPanes } from '../store/migrations.js';
import type { PaneManager } from '../runtime/PaneManager.js';
import { randomWorkspaceName } from '../random-name.js';

export function workspacesRoutes(deps: {
  db: Database.Database;
  paneManager: PaneManager;
}): Hono {
  const app = new Hono();
  const workspaces = new WorkspaceStore(deps.db);
  const panes = new PaneStore(deps.db);

  app.post('/', async (c) => {
    const body = z
      .object({
        name: z.string().optional(),
        layout: LayoutNodeSchema.optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const name = body.name?.trim() || randomWorkspaceName();
    const w = workspaces.create({ name, layout: body.layout ?? '' });
    return c.json(w, 201);
  });

  app.get('/', (c) => {
    const list = workspaces.list();
    // Fold in per-workspace attention flag from the live PaneManager. A
    // workspace flags as needing attention if any of its panes has rung
    // BEL since the user last interacted with it. Panes whose runtime
    // isn't running (lazy-spawn, no client connected) contribute false.
    const decorated = list.map((w) => {
      const wsPanes = panes.listByWorkspace(w.id);
      const attention = wsPanes.some((p) => deps.paneManager.get(p.id)?.getNeedsAttention() ?? false);
      return { ...w, attention };
    });
    return c.json(decorated);
  });

  // Mark every pane in a workspace as "seen". Called by the web client
  // when the user navigates to a workspace tab — counts as an interaction
  // so the tab indicator doesn't reappear if they leave without typing.
  app.post('/:id/seen', (c) => {
    const id = c.req.param('id');
    for (const p of panes.listByWorkspace(id)) {
      deps.paneManager.get(p.id)?.markSeen();
    }
    return c.body(null, 204);
  });

  app.post('/reorder', async (c) => {
    const body = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
    workspaces.reorder(body.ids);
    return c.body(null, 204);
  });

  app.get('/:id', (c) => {
    const w = workspaces.getById(c.req.param('id'));
    if (!w)
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    const livePanes = panes.listByWorkspace(w.id);
    const valid = new Set(livePanes.map((p) => p.id));
    const cleaned = pruneDeadPanes(w.layout, valid);
    if (JSON.stringify(cleaned) !== JSON.stringify(w.layout)) {
      workspaces.update(w.id, { layout: cleaned });
      w.layout = cleaned;
    }
    // Decorate each pane with runtime-only fields used to label it in the
    // UI: the latest OSC title (real-time, set by the running program)
    // and the cached foreground command (polled every 10s as a fallback).
    const decorated = livePanes.map((p) => ({
      ...p,
      title: deps.paneManager.get(p.id)?.getCurrentTitle() ?? null,
      foreground_cmd: deps.paneManager.getForegroundCommand(p.id),
    }));
    return c.json({ ...w, panes: decorated });
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
      const w = workspaces.update(c.req.param('id'), body);
      return c.json(w);
    } catch {
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    }
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const ws = workspaces.getById(id);
    if (!ws)
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    for (const p of panes.listByWorkspace(id)) {
      await deps.paneManager.kill(p.id);
    }
    workspaces.delete(id);
    return c.body(null, 204);
  });

  return app;
}
