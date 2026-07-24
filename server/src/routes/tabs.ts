import { LayoutNodeSchema, appendLeafToLayout, collectLayoutLeaves } from '@muxpad/shared';
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
        // Optional model for an agent bootstrap. Lands in the pane's
        // startup_cmd (which runs through a shell), so the charset is
        // strictly gated: model ids like 'claude-opus-4-8[1m]' pass, shell
        // metacharacters cannot.
        model: z
          .string()
          .regex(/^[A-Za-z0-9._[\]-]{1,64}$/)
          .optional(),
        // Which agent backend an 'agent' bootstrap runs (default claude).
        // Allowlisted enum → safe to bake into the startup_cmd shell string.
        // 'pick' = created pending, harness chosen later in the chat page.
        backend: z.enum(['claude', 'codex', 'cursor', 'pick']).optional(),
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
        // Single-quoted model so zsh's nomatch can't glob-error on ids with
        // brackets ('claude-opus-4-8[1m]'); the charset gate above makes the
        // quoting safe. Claude stays implicit (no --backend) so its cmd is
        // unchanged; codex/cursor get an explicit, allowlisted flag.
        startup_cmd: agent
          ? body.backend === 'pick'
            ? 'muxpad agent --pick'
            : `muxpad agent${body.backend && body.backend !== 'claude' ? ` --backend ${body.backend}` : ''}${body.model ? ` --model '${body.model}'` : ''}`
          : null,
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
    // Fold in the two independent per-tab signals:
    //   attention (red dot, "wants you NOW") = any pane rang BEL since you
    //     last interacted. Purely runtime.
    //   unread (bold name, "done, unreviewed") = the tab was manually marked
    //     unread, OR any pane is unread (an agent finished a turn there while
    //     you weren't looking). DB-persisted.
    // Panes whose runtime isn't running (lazy-spawn, no client) contribute
    // false to attention/busy; their persisted `unread` still counts.
    const manualUnreadIds = tabs.unreadIdsByWorkspace(workspaceId);
    const decorated = list.map((t) => {
      const tabPanes = panes.listByTab(t.id);
      const attention = tabPanes.some((p) => deps.cache.getAttention(p.id));
      const unread = manualUnreadIds.has(t.id) || tabPanes.some((p) => p.unread);
      // Busy = any pane in the tab is actively producing output. Purely
      // runtime (never persisted) and clears itself when the work goes quiet.
      const busy = tabPanes.some((p) => deps.cache.getBusy(p.id));
      return { ...t, attention, unread, busy };
    });
    return c.json(decorated);
  });

  // Mark every pane in a tab as "seen". Called by the web client when
  // the user navigates to a tab — counts as an interaction so the tab
  // attention dot doesn't reappear if they leave without typing.
  app.post('/:id/seen', async (c) => {
    const id = c.req.param('id');
    // Viewing the tab clears the read-state flags — seeing it is the read
    // action: the manual tab "unread" mark AND every pane's "done, unreviewed"
    // bold. Synchronous DB writes, independent of ptyd.
    tabs.setUnread(id, false);
    const tabPanes = panes.listByTab(id);
    for (const p of tabPanes) {
      if (!p.unread) continue;
      panes.setUnread(p.id, false);
      // Emit so OTHER connected clients drop the bold immediately instead of
      // waiting for their next nav poll (parity with the pane /seen route).
      const fresh = panes.getById(p.id);
      if (fresh)
        deps.events.emit({
          type: 'pane.updated',
          tab_id: fresh.tab_id,
          pane: decoratePane(deps.cache, fresh),
        });
    }
    // Issue markSeen (BEL/red-dot clear) against ptyd in parallel; swallow
    // per-pane failures (idempotent — markSeen on a missing id is a no-op on
    // ptyd's side). No response payload, so the round-trip latency only blocks
    // the 204 response — clients don't wait on it before navigating.
    await Promise.all(
      tabPanes.map((p) =>
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

  // Merge this tab's panes into another tab, then delete the (now empty)
  // source. The gather inverse of the pane-move "pop out" — turns N
  // single-pane tabs into one tab with N pane-tabs. Pure metadata: ptys and
  // agent runners key by pane id, so nothing running notices the move.
  // Cross-workspace merges are allowed (the sidebar drop targets span
  // workspaces).
  app.post('/:id/merge', async (c) => {
    const id = c.req.param('id');
    const body = z.object({ into_tab_id: z.string() }).parse(await c.req.json().catch(() => ({})));
    const source = tabs.getById(id);
    if (!source) return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    if (body.into_tab_id === id)
      return c.json({ error: { code: 'bad_request', message: 'cannot merge a tab into itself' } }, 400);
    const dest = tabs.getById(body.into_tab_id);
    if (!dest)
      return c.json({ error: { code: 'not_found', message: 'destination tab not found' } }, 404);
    const sourceWs = tabs.getWorkspaceId(id);
    const destWs = tabs.getWorkspaceId(dest.id);
    if (!sourceWs || !destWs)
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);

    // Enumerate the source's pane ROWS, not its layout leaves: pane rows and
    // the stored layout JSON can drift (row committed, layout write pending/
    // failed), and any row missed here would be destroyed by the panes'
    // ON DELETE CASCADE when the source tab is deleted below — silent pane
    // loss. Layout order first (keeps strip order), stragglers appended.
    const rows = panes.listByTab(id).map((p) => p.id);
    const rowSet = new Set(rows);
    const inLayout = collectLayoutLeaves(source.layout).filter((pid) => rowSet.has(pid));
    const inLayoutSet = new Set(inLayout);
    const paneIds = [...inLayout, ...rows.filter((pid) => !inLayoutSet.has(pid))];

    // Reparent every pane BEFORE deleting the source tab — rows already
    // pointing at dest are out of the cascade's blast radius.
    const { finalDest } = deps.db.transaction(() => {
      let layout = dest.layout;
      for (const pid of paneIds) {
        panes.setTab(pid, dest.id);
        layout = appendLeafToLayout(layout, pid);
      }
      const fd = tabs.update(dest.id, { layout });
      tabs.delete(id);
      return { finalDest: fd };
    })();

    // Destination events first (same convention as the pane-move route): a
    // client viewing dest must have the panes before the layout referencing
    // them lands.
    for (const pid of paneIds) {
      const p = panes.getById(pid);
      if (p) deps.events.emit({ type: 'pane.added', tab_id: dest.id, pane: decoratePane(deps.cache, p) });
    }
    deps.events.emit({ type: 'tab.updated', tab: finalDest });
    for (const pid of paneIds) {
      deps.events.emit({ type: 'pane.removed', tab_id: id, pane_id: pid });
    }
    deps.events.emit({ type: 'tab.removed', workspace_id: sourceWs, tab_id: id });

    return c.json({ to_tab: finalDest, from_tab_id: id, moved_pane_ids: paneIds });
  });

  return app;
}
