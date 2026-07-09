import { LayoutNodeSchema } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EventBus } from '../events.js';
import { queuePaneKill } from '../pane-reaper.js';
import { type PtydCache, decoratePane } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { randomWorkspaceName } from '../random-name.js';
import { safeCwd } from '../safe-cwd.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { pruneDeadPanes } from '../store/migrations.js';

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
        // Atomic tab-with-pane creation — the tabs-first default. 'shell'
        // gives a full-size terminal; 'agent' a chat-native Claude session
        // (`muxpad agent` startup command, chat face). One request replaces
        // the old createTab → createPane → patchTab client dance, so a tab
        // can never be observed half-bootstrapped.
        bootstrap: z.enum(['shell', 'agent']).optional(),
        // Optional cwd for the bootstrapped pane.
        cwd: z.string().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    // Agent tabs get a deliberate name + mark (auto-renamed to the session's
    // AI title once the conversation has one); everything else keeps the
    // random-name default.
    const name =
      body.name?.trim() || (body.bootstrap === 'agent' ? 'agent' : randomWorkspaceName());
    // Transaction so a mid-request failure can't commit a half-bootstrapped
    // ghost tab (tab row present, pane/layout missing).
    const created = deps.db.transaction(() => {
      let tab = tabs.create({
        name,
        layout: body.layout ?? '',
        workspace_id: body.workspace_id,
        ...(body.bootstrap === 'agent' ? { icon: '✳' } : {}),
      });
      if (!body.bootstrap) return { tab, pane: null };
      const agent = body.bootstrap === 'agent';
      const pane = panes.create({
        tab_id: tab.id,
        shell: process.env.SHELL ?? '/bin/zsh',
        cwd: safeCwd(body.cwd),
        startup_cmd: agent ? 'muxpad agent' : null,
        // Agent tabs land directly on the chat face; the (hidden) terminal
        // face spawns the pty underneath, which runs the startup command.
        face: agent ? 'chat' : 'terminal',
      });
      tab = tabs.update(tab.id, { layout: pane.id }) ?? tab;
      return { tab, pane };
    })();
    const t = created.tab;
    const bootstrappedPane = created.pane;
    deps.events.emit({ type: 'tab.added', workspace_id: body.workspace_id, tab: t });
    if (bootstrappedPane) {
      deps.events.emit({ type: 'pane.added', tab_id: t.id, pane: bootstrappedPane });
      // Eager spawn (same as the panes route): an agent tab created from a
      // phone starts its runner immediately, before any terminal view ever
      // attaches.
      try {
        await deps.ptyd.ensurePane({
          id: bootstrappedPane.id,
          shell: bootstrappedPane.shell ?? process.env.SHELL ?? '/bin/zsh',
          startup_cmd: bootstrappedPane.startup_cmd,
          cwd: safeCwd(bootstrappedPane.cwd),
          env: bootstrappedPane.env,
          tab_id: t.id,
          workspace_id: body.workspace_id,
        });
      } catch {
        // ptyd unreachable: the rows are committed; the runtime spawns
        // lazily when a client attaches and ptyd reconnects.
      }
    }
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
    // Fold in per-tab attention flag. A tab flags as needing attention if
    // it was manually marked unread, OR any of its panes has rung BEL
    // since the user last interacted with it. Panes whose runtime isn't
    // running (lazy-spawn, no client connected) contribute false.
    const unreadIds = tabs.unreadIdsByWorkspace(workspaceId);
    const decorated = list.map((t) => {
      const tabPanes = panes.listByTab(t.id);
      const attention = unreadIds.has(t.id) || tabPanes.some((p) => deps.cache.getAttention(p.id));
      // Busy = any pane in the tab is actively producing output. Unlike
      // attention this is purely runtime (never manual/persisted) and clears
      // itself when the work goes quiet.
      const busy = tabPanes.some((p) => deps.cache.getBusy(p.id));
      return { ...t, attention, busy };
    });
    return c.json(decorated);
  });

  // Mark every pane in a tab as "seen". Called by the web client when
  // the user navigates to a tab — counts as an interaction so the tab
  // attention dot doesn't reappear if they leave without typing.
  app.post('/:id/seen', async (c) => {
    const id = c.req.param('id');
    // Viewing the tab also clears any manual "unread" mark — seeing it is
    // the read action. Synchronous DB write, independent of ptyd.
    tabs.setUnread(id, false);
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

  // Manually flag a tab "unread" — restores the attention dot until the
  // tab is next viewed. Complements the BEL-driven runtime attention;
  // persisted in the DB so it survives ptyd/server restarts and needs no
  // ptyd round-trip. The initiating client refreshes its tab list; other
  // clients pick it up on the next poll.
  app.post('/:id/unread', (c) => {
    const id = c.req.param('id');
    if (!tabs.getById(id))
      return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    tabs.setUnread(id, true);
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
    if (!t) return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    const livePanes = panes.listByTab(t.id);
    const valid = new Set(livePanes.map((p) => p.id));
    const cleaned = pruneDeadPanes(t.layout, valid);
    if (JSON.stringify(cleaned) !== JSON.stringify(t.layout)) {
      tabs.update(t.id, { layout: cleaned });
      t.layout = cleaned;
    }
    const decorated = livePanes.map((p) => decoratePane(deps.cache, p));
    return c.json({ ...t, panes: decorated });
  });

  app.patch('/:id', async (c) => {
    const body = z
      .object({
        name: z.string().optional(),
        slug: z.string().optional(),
        icon: z.string().optional(),
        layout: LayoutNodeSchema.optional(),
        // Desktop split ⇄ tabbed rendering mode. Persisted so the choice
        // follows the user across devices (the emitted tab.updated syncs
        // other connected clients live).
        view_mode: z.enum(['split', 'tabbed']).optional(),
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
    if (!t) return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
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
        // ptyd unreachable / kill lost in transit: the DB cascade proceeds,
        // so queue the kill durably — the reaper retries until the pty is
        // confirmed gone (otherwise it would run forever, invisible).
        queuePaneKill(deps.db, p.id);
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

  // Move a whole tab (and all its panes) to a different workspace. Pure FK
  // reparent — the panes reference the tab, not the workspace, so they come
  // along with no layout surgery and no PTY churn. Surfaced to clients as a
  // tab.removed (old workspace) + tab.added (new workspace) pair, which the
  // global event router turns into the right per-workspace tab-list refreshes.
  app.post('/:id/move', async (c) => {
    const id = c.req.param('id');
    const body = z.object({ workspace_id: z.string() }).parse(await c.req.json().catch(() => ({})));
    const fromWorkspace = tabs.getWorkspaceId(id);
    if (!fromWorkspace)
      return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    if (fromWorkspace === body.workspace_id) {
      // No-op — already there. Return the current tab unchanged.
      const t = tabs.getById(id);
      return c.json(t);
    }
    let updated: ReturnType<typeof tabs.setWorkspace>;
    try {
      updated = tabs.setWorkspace(id, body.workspace_id);
    } catch {
      // setWorkspace throws on a missing tab or (via the workspace_id FK) a
      // non-existent target workspace.
      return c.json(
        { error: { code: 'bad_request', message: 'tab or target workspace not found' } },
        400,
      );
    }
    deps.events.emit({ type: 'tab.removed', workspace_id: fromWorkspace, tab_id: id });
    deps.events.emit({ type: 'tab.added', workspace_id: body.workspace_id, tab: updated });
    return c.json(updated);
  });

  return app;
}
