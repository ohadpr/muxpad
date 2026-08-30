import { type PaneStatus, rollupStatus } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EventBus } from '../events.js';
import { type PtydCache, decorateWorkspace } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';

/**
 * CRUD for the top-level workspace concept. Workspaces own tabs; tabs
 * own panes. Lives at /api/workspaces; tab routes live at /api/tabs.
 */
export function workspacesRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
}): Hono {
  const app = new Hono();
  const workspaces = new WorkspaceStore(deps.db);
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);

  /**
   * The rollup signals for a workspace, mirroring the per-tab fold in
   * routes/tabs.ts so the workspace-level and tab-level indicators never
   * disagree:
   *   attention (red dot) = any pane rang BEL since last seen. Runtime.
   *   unread (bold name)  = any tab manually marked unread, OR any pane is
   *     unread (an agent finished a turn there unobserved). Persisted.
   *   status              = the highest-precedence status across every pane in
   *     every tab, folded through the SAME rollupStatus primitive the tab level
   *     uses. Computed ALWAYS.
   *   agents              = live background subagents in the whole workspace.
   *
   * D2: `status` is the fix for the workspace that has no working signal of any
   * kind. The per-tab spinners live in TabList, which mounts only while the
   * workspace is EXPANDED — and the default expansion is active-workspace-only.
   * So on a fresh profile every agent working in a collapsed workspace was
   * invisible, its 5s poll was stopped, and the live-refresh path skipped it
   * for want of a cache entry. This row is computed server-side on every list
   * call, so a collapsed workspace can say "something is running in here"
   * without mounting anything.
   */
  app.get('/', (c) => {
    // Hidden system workspaces (the retired resident pane's container) are
    // excluded from the
    // default list — and thus the sidebar tree — unless ?all=1.
    const list = workspaces.list({ all: c.req.query('all') === '1' });
    const decorated = list.map((w) => decorateWorkspace(deps.cache, deps.db, w));
    return c.json(decorated);
  });

  app.post('/', async (c) => {
    const body = z
      .object({ name: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const name = body.name?.trim() || nextDefaultName(workspaces.list());
    const created = workspaces.create({ name });
    deps.events.emit({
      type: 'workspace.added',
      workspace: decorateWorkspace(deps.cache, deps.db, created),
    });
    return c.json(created, 201);
  });

  app.get('/:id', (c) => {
    const w = workspaces.getById(c.req.param('id'));
    if (!w) return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    return c.json(decorateWorkspace(deps.cache, deps.db, w));
  });

  app.patch('/:id', async (c) => {
    const body = z
      .object({ name: z.string().optional(), slug: z.string().optional() })
      .parse(await c.req.json());
    try {
      const updated = workspaces.update(c.req.param('id'), body);
      deps.events.emit({
        type: 'workspace.updated',
        workspace: decorateWorkspace(deps.cache, deps.db, updated),
      });
      return c.json(updated);
    } catch {
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    }
  });

  /**
   * Cascades tabs → panes → workspace. See inline comment below for
   * which events are emitted and why. The previous 409 "drain first"
   * model was replaced when mobile's merged workspace+tab switcher
   * needed a single delete-folder action.
   */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const w = workspaces.getById(id);
    if (!w) return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    // Cascade: kill panes, drop tabs, then drop the workspace. Pane
    // rows fall out via the ON DELETE CASCADE FK on tabs; the explicit
    // tabs.delete() per tab is what lets us emit a per-tab tab.removed
    // event (so any open TabView routes itself away). Clients infer
    // the cascade-pane removals from tab.removed; we intentionally do
    // not emit per-pane events here, matching the single-tab DELETE
    // path in routes/tabs.ts.
    //
    // Was a 409 "drain first" before — fine for the desktop UX where
    // tabs close one by one, but mobile's merged switcher expects a
    // "delete folder" semantic and there's no clean way to drain from
    // there. Doing the cascade here also removes the race window the
    // client hit when issuing parallel tab-deletes before the
    // workspace-delete.
    for (const t of tabs.listByWorkspace(id)) {
      for (const p of panes.listByTab(t.id)) {
        try {
          await deps.ptyd.killPane(p.id);
        } catch {
          // ptyd disconnected; the DB cascade proceeds regardless. ptyd
          // has no persistent state.
        }
        deps.cache.forget(p.id);
      }
      tabs.delete(t.id);
      deps.events.emit({ type: 'tab.removed', workspace_id: id, tab_id: t.id });
    }
    workspaces.delete(id);
    deps.events.emit({ type: 'workspace.removed', workspace_id: id });
    return c.body(null, 204);
  });

  app.post('/reorder', async (c) => {
    const body = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
    workspaces.reorder(body.ids);
    return c.body(null, 204);
  });

  return app;
}

/**
 * Pick the next default workspace name. Looks for the highest integer N
 * across existing names matching "Workspace N" and returns "Workspace N+1".
 * Returns "Workspace 1" when no such name exists. Numbers are not reused
 * when a workspace is deleted — predictability beats density.
 */
function nextDefaultName(existing: { name: string }[]): string {
  let max = 0;
  for (const w of existing) {
    const m = /^Workspace (\d+)$/.exec(w.name);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `Workspace ${max + 1}`;
}
