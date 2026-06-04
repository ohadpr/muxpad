import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { LayoutNodeSchema } from '@muxpad/shared';
import { TabStore } from '../store/TabStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { pruneDeadPanes } from '../store/migrations.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import type { PtydCache } from '../ptyd-cache.js';
import { randomWorkspaceName } from '../random-name.js';
import type { EventBus } from '../events.js';

/**
 * CRUD for tabs (the things in the tab bar). Each tab belongs to a
 * parent workspace. List queries are scoped via `?workspaceId=…`.
 */
export function tabsRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
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
    deps.events.emit({ type: 'tab.added', workspace_id: body.workspace_id, tab: t });
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
    // Fold in per-tab attention flag from the ptyd cache. A tab flags as
    // needing attention if any of its panes has rung BEL since the user
    // last interacted with it. Panes whose runtime isn't running
    // (lazy-spawn, no client connected) contribute false.
    const decorated = list.map((t) => {
      const tabPanes = panes.listByTab(t.id);
      const attention = tabPanes.some((p) => deps.cache.getAttention(p.id));
      return { ...t, attention };
    });
    return c.json(decorated);
  });

  // Mark every pane in a tab as "seen". Called by the web client when
  // the user navigates to a tab — counts as an interaction so the tab
  // attention dot doesn't reappear if they leave without typing.
  app.post('/:id/seen', async (c) => {
    const id = c.req.param('id');
    // Issue markSeen against ptyd in parallel; swallow per-pane failures
    // (idempotent — markSeen on a missing id is a no-op on ptyd's side).
    // No response payload, so the round-trip latency only blocks the 204
    // response — clients don't wait on it before navigating.
    await Promise.all(
      panes.listByTab(id).map((p) =>
        deps.ptyd.markSeen(p.id).catch(() => {
          // ignore — markSeen is best-effort
        }),
      ),
    );
    return c.body(null, 204);
  });

  app.post('/reorder', async (c) => {
    const body = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
    tabs.reorder(body.ids);
    // TODO(events): tab reorder changes `position` for N tabs in bulk.
    // Emitting one tab.updated per touched row would work but the Tab
    // schema doesn't actually expose position to clients, so a single
    // event would carry no useful diff. The 5s poll covers this case
    // until we either widen TabSchema or add a coarse workspace event.
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
      title: deps.cache.getTitle(p.id),
      foreground_cmd: deps.cache.getFg(p.id),
      attention: deps.cache.getAttention(p.id),
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
      deps.events.emit({ type: 'tab.updated', tab: t });
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
    // TabStore.getById doesn't surface workspace_id (the shared Tab type
    // omits it). Pull it via the dedicated helper so the emitted event
    // carries the right workspace context for clients.
    const workspaceId = tabs.getWorkspaceId(id);
    // ptyd holds runtime state; SQLite is the source of truth. If ptyd
    // is unreachable, the DB cascade must still proceed — ptyd has no
    // persistent state, so when it reconnects it doesn't need cleanup.
    for (const p of panes.listByTab(id)) {
      try {
        await deps.ptyd.killPane(p.id);
      } catch {
        // ptyd disconnected; continue with the cascade.
      }
      deps.cache.forget(p.id);
    }
    tabs.delete(id);
    if (workspaceId) {
      // Clients infer the cascade-pane removals from tab.removed; we
      // intentionally do not emit per-pane events here.
      deps.events.emit({ type: 'tab.removed', workspace_id: workspaceId, tab_id: id });
    }
    return c.body(null, 204);
  });

  return app;
}
