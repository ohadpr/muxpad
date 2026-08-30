import type { Tab } from '@muxpad/shared';
import {
  AgentModeSchema,
  LayoutNodeSchema,
  appendLeafToLayout,
  collectLayoutLeaves,
  rollupStatus,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import { bootstrapTab, deleteTabCascade } from '../agent-tab.js';
import type { EventBus } from '../events.js';
import { hasProjectContext } from '../project-root.js';
import { type PtydCache, cronsByTab, decoratePane, decorateTab } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { randomWorkspaceName } from '../random-name.js';
import { safeCwd } from '../safe-cwd.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { pruneDeadPanes } from '../store/migrations.js';
import { type TabActivity, compareUnpinnedTabs } from '../tab-activity.js';

/**
 * CRUD for tabs (the things in the tab bar). Each tab belongs to a
 * parent workspace. List queries are scoped via `?workspaceId=…`.
 */
export function tabsRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
  /** Only used to drop a deleted tab's throttle memo — see TabActivity.forget. */
  tabActivity?: TabActivity;
}): Hono {
  const app = new Hono();
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);
  // Only for refusing hidden system containers as a move/merge destination.
  const workspaces = new WorkspaceStore(deps.db);

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
        // Agent behavior mode for an 'agent' bootstrap (⚡ do / 🧠 deep;
        // default deep = today's behavior). Rides the pane row AND the
        // startup_cmd, so it survives respawns. Allowlisted enum → safe to
        // bake into the shell string.
        mode: AgentModeSchema.optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    // Agent tabs get a deliberate name + mark (auto-renamed to the session's
    // AI title once the conversation has one); everything else keeps the
    // random-name default. Rows, events and the eager ptyd spawn live in
    // bootstrapTab — shared verbatim with the cron scheduler's new-tab mode.
    const name =
      body.name?.trim() || (body.bootstrap === 'agent' ? 'agent' : randomWorkspaceName());
    const created = await bootstrapTab(deps, {
      workspace_id: body.workspace_id,
      name,
      ...(body.layout !== undefined ? { layout: body.layout as string } : {}),
      ...(body.bootstrap ? { bootstrap: body.bootstrap } : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.backend !== undefined ? { backend: body.backend } : {}),
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.bootstrap === 'agent' ? { icon: '✳' } : {}),
    });
    return c.json(created.tab, 201);
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
    // decorateTab is the ONE place this composition lives (mirroring
    // decoratePane) — every tab.updated / tab.added emitter routes through it
    // too, so the list and the live events can't describe a tab differently.
    const manualUnreadIds = tabs.unreadIdsByWorkspace(workspaceId);
    // One cron query for the whole workspace (see cronsByTab) — the sidebar
    // polls this route every 5s, so a per-row lookup would be the hottest
    // query in the app.
    const cronIds = cronsByTab(deps.db, workspaceId);
    const decorated = list.map((t) =>
      decorateTab(deps.cache, deps.db, t, manualUnreadIds, cronIds),
    );
    // ── The living sidebar's order ────────────────────────────────────────
    // PINNED tabs first, in the user's manual drag order (`list` already
    // arrives position-sorted, so a stable partition preserves it). Then the
    // rest, auto-sorted: needs-attention → most recently active, with
    // position and id as the final tiebreaks so the order is TOTAL and can't
    // jitter between two renders of identical data.
    //
    // Sorting here rather than in the client means every consumer (web,
    // sheet, CLI, a future surface) sees one authoritative order, and the
    // recency/attention inputs never have to be re-derived.
    const positions = new Map(list.map((t, i) => [t.id, i]));
    const pinned = decorated.filter((t) => t.pinned);
    const rest = decorated
      .filter((t) => !t.pinned)
      .sort((a, b) => compareUnpinnedTabs(a, b, positions));
    return c.json([...pinned, ...rest]);
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
    const parsed = z
      .object({
        name: z.string().optional(),
        slug: z.string().optional(),
        icon: z.string().optional(),
        layout: LayoutNodeSchema.optional(),
        // Desktop split ⇄ tabbed rendering mode. Persisted so the choice
        // follows the user across devices (the emitted tab.updated syncs
        // other connected clients live).
        view_mode: z.enum(['split', 'tabbed']).optional(),
        // Living sidebar: pin this tab to the top of its workspace block, in
        // the manual drag order. Handled outside TabStore.update because it
        // is a flag, not one of the row's structural fields (and must not
        // bump updated_at semantics for the others).
        pinned: z.boolean().optional(),
      })
      // safeParse, not parse: a malformed body is the caller's fault (400),
      // not a 500 from an uncaught ZodError escaping the handler.
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: parsed.error.issues[0]?.message ?? 'invalid body',
          },
        },
        400,
      );
    const body = parsed.data;
    const id = c.req.param('id');

    // ── VALIDATE, THEN MUTATE, IN ONE TRANSACTION ───────────────────────────
    // This used to pin (and reposition) the tab, then call tabs.update(), then
    // report 404 from a bare catch if that threw. So `{pinned:true, slug:'…'}`
    // with a bad slug persisted the pin AND the position change, emitted
    // nothing, and told the caller the tab didn't exist. Existence is checked
    // once up front, and both writes now commit or roll back together.
    if (!tabs.getById(id))
      return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    const { pinned, ...rowPatch } = body;
    let updated: Tab;
    try {
      updated = deps.db.transaction((): Tab => {
        if (pinned !== undefined) {
          tabs.setPinned(id, pinned);
          // Newly pinned tabs land at the END of the pinned block: appending is
          // the only placement that can't silently displace an order the user
          // already arranged. They can drag from there.
          if (pinned) {
            const maxPos = deps.db
              .prepare(
                'SELECT COALESCE(MAX(position), -1) AS m FROM tabs WHERE workspace_id = (SELECT workspace_id FROM tabs WHERE id = ?) AND pinned = 1 AND id != ?',
              )
              .get(id, id) as { m: number } | undefined;
            deps.db
              .prepare('UPDATE tabs SET position = ? WHERE id = ?')
              .run((maxPos?.m ?? -1) + 1, id);
          }
        }
        // With an all-undefined patch `update` rewrites every column to its
        // current value and DOES bump `updated_at` — so a pin/unpin counts as a
        // structural edit. That's deliberate (pinning is an explicit user act,
        // unlike the pty-driven `touchActivity`, which avoids updated_at
        // precisely because it fires on its own). We call it either way to get
        // a freshly-read Tab to emit and return.
        return tabs.update(id, rowPatch);
      })();
    } catch (err) {
      // The tab exists (checked above), so a throw here is the patch itself
      // being rejected — a duplicate slug, most likely. Say that, instead of
      // the old misleading 404.
      return c.json({ error: { code: 'conflict', message: (err as Error).message } }, 409);
    }
    deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, updated) });
    return c.json(updated);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    // Kills, the DB cascade, cache/activity memo cleanup and the tab.removed
    // event all live in deleteTabCascade — shared with the cron scheduler's
    // close-when-done, so a scheduled tab is torn down exactly like a manual one.
    const ok = await deleteTabCascade(
      { ...deps, ...(deps.tabActivity ? { tabActivity: deps.tabActivity } : {}) },
      id,
    );
    if (!ok) return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
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
    // A HIDDEN workspace is a system container (the apps container), not a
    // destination. A tab moved there vanishes from every navigator with no way
    // back, and the app registry's teardown will happily delete whatever tab
    // its pane is alone in. The pane-move route already refuses this for
    // `new_tab` destinations (routes/panes.ts); this is the same refusal for
    // whole tabs, and for the same reason.
    //
    // ONLY the hidden case is checked here. A workspace that does not exist at
    // all keeps falling through to the FK failure below, which answers 400 —
    // pre-existing contract, and not this change's business to alter.
    if (workspaces.getById(body.workspace_id)?.hidden)
      return c.json({ error: { code: 'not_found', message: 'target workspace not found' } }, 404);
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
    deps.events.emit({
      type: 'tab.added',
      workspace_id: body.workspace_id,
      tab: decorateTab(deps.cache, deps.db, updated),
    });
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
      return c.json(
        { error: { code: 'bad_request', message: 'cannot merge a tab into itself' } },
        400,
      );
    const dest = tabs.getById(body.into_tab_id);
    if (!dest)
      return c.json({ error: { code: 'not_found', message: 'destination tab not found' } }, 404);
    const sourceWs = tabs.getWorkspaceId(id);
    const destWs = tabs.getWorkspaceId(dest.id);
    if (!sourceWs || !destWs)
      return c.json({ error: { code: 'not_found', message: 'workspace not found' } }, 404);
    // Merging INTO a hidden container is the same one-way trip as moving there
    // (see POST /:id/move) — the merged panes would land in a workspace no
    // navigator lists. Merging OUT of one is fine and deliberate: it is a way
    // back for anything stranded there.
    if (workspaces.getById(destWs)?.hidden)
      return c.json({ error: { code: 'not_found', message: 'destination tab not found' } }, 404);

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
    deps.tabActivity?.forget(id); // source tab is gone — drop its memo

    // Destination events first (same convention as the pane-move route): a
    // client viewing dest must have the panes before the layout referencing
    // them lands.
    for (const pid of paneIds) {
      const p = panes.getById(pid);
      if (p)
        deps.events.emit({
          type: 'pane.added',
          tab_id: dest.id,
          pane: decoratePane(deps.cache, p),
        });
    }
    deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, finalDest) });
    for (const pid of paneIds) {
      deps.events.emit({ type: 'pane.removed', tab_id: id, pane_id: pid });
    }
    deps.events.emit({ type: 'tab.removed', workspace_id: sourceWs, tab_id: id });

    return c.json({ to_tab: finalDest, from_tab_id: id, moved_pane_ids: paneIds });
  });

  return app;
}
