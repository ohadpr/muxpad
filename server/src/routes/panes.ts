import { Hono } from 'hono';
import { z } from 'zod';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import type { LayoutNode } from '@muxpad/shared';
import { spliceLayoutAtTarget } from '@muxpad/shared';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import type { PtydCache } from '../ptyd-cache.js';
import type { EventBus } from '../events.js';

const defaultShell = process.env.SHELL ?? '/bin/zsh';

/**
 * Place `newId` in the layout as a `direction`-split of `sourceId`. If
 * `sourceId` isn't in the tree (CLI run outside a pane, or stale id),
 * fall back to appending at the root. Empty layout → new pane becomes
 * the root.
 *
 * Used by POST /api/tabs/:id/panes when the caller asks for an atomic
 * create-and-place via `append_to_layout` (CLI, agents). The UI patches
 * layout in a separate request and doesn't go through here.
 */
function appendPaneToLayout(
  layout: LayoutNode,
  sourceId: string | null,
  newId: string,
  direction: 'row' | 'column',
  position: 'after' | 'before',
): LayoutNode {
  if (sourceId !== null) {
    const { layout: next, placed } = spliceLayoutAtTarget(
      layout,
      sourceId,
      newId,
      direction,
      position,
    );
    if (placed) return next;
  }
  // No source, or source not anywhere in the tree → append at root so
  // the new pane is at least visible. Honor `position` here too: a CLI
  // call that says "above" with no resolvable target should still land
  // the new pane on top of the existing layout, not below it.
  if (layout === '' || layout == null) return newId;
  return position === 'before'
    ? { direction, first: newId, second: layout }
    : { direction, first: layout, second: newId };
}

/**
 * Panes are spawned under a specific tab — `POST /api/tabs/:id/panes`.
 */
export function panesTabScopedRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);

  app.post('/:id/panes', async (c) => {
    const tabId = c.req.param('id');
    const t = tabs.getById(tabId);
    if (!t)
      return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    const body = z
      .object({
        kind: z.enum(['shell', 'url']).optional(),
        url: z.string().url().nullable().optional(),
        shell: z.string().optional(),
        startup_cmd: z.string().nullable().optional(),
        cwd: z.string().optional(),
        env: z.record(z.string()).nullable().optional(),
        inherit_cwd_from: z.string().optional(),
        // Layout placement controls. Off by default — the UI patches the
        // tab's layout in a separate request after creating the pane. When
        // `append_to_layout` is true the server places the new pane atomically:
        // split-right of `split_from` if given, else appended at root.
        // This is what the CLI uses; without it a CLI-created pane would
        // be invisible in the mosaic (row exists, not in layout tree).
        append_to_layout: z.boolean().optional(),
        split_from: z.string().optional(),
        direction: z.enum(['row', 'column']).optional(),
        position: z.enum(['after', 'before']).optional(),
      })
      .parse(await c.req.json().catch(() => ({})));

    const kind = body.kind ?? 'shell';
    if (kind === 'url') {
      if (!body.url) {
        return c.json(
          { error: { code: 'bad_request', message: 'url required for kind=url' } },
          400,
        );
      }
      if (body.shell || body.startup_cmd || body.cwd || body.env || body.inherit_cwd_from) {
        return c.json(
          {
            error: {
              code: 'bad_request',
              message: 'shell/cwd/startup_cmd/env/inherit_cwd_from not allowed for kind=url',
            },
          },
          400,
        );
      }
      const pane = panes.create({ tab_id: tabId, kind: 'url', url: body.url });
      deps.events.emit({ type: 'pane.added', tab_id: tabId, pane });
      if (body.append_to_layout) {
        const nextLayout = appendPaneToLayout(
          t.layout,
          body.split_from ?? null,
          pane.id,
          body.direction ?? 'row',
          body.position ?? 'after',
        );
        const updated = tabs.update(tabId, { layout: nextLayout });
        if (updated) deps.events.emit({ type: 'tab.updated', tab: updated });
      }
      return c.json(pane, 201);
    }

    // cwd resolution order: explicit `cwd` wins → else inherit from a sibling
    // pane's *current* shell cwd (from the synchronous ptyd cache) → else
    // that sibling's stored spawn cwd → else homedir.
    let cwd = body.cwd;
    if (!cwd && body.inherit_cwd_from) {
      const source = panes.getById(body.inherit_cwd_from);
      if (source && source.tab_id === tabId) {
        const live = deps.cache.getCwd(source.id);
        // source.cwd is nullable since the schema widening for URL panes;
        // collapse null back to undefined so the homedir() default below fires.
        cwd = live ?? source.cwd ?? undefined;
      }
    }

    const pane = panes.create({
      tab_id: tabId,
      shell: body.shell ?? defaultShell,
      cwd: cwd ?? homedir(),
      startup_cmd: body.startup_cmd ?? null,
      env: body.env ?? null,
    });
    deps.events.emit({ type: 'pane.added', tab_id: tabId, pane });
    if (body.append_to_layout) {
      const nextLayout = appendPaneToLayout(
        t.layout,
        body.split_from ?? null,
        pane.id,
        body.direction ?? 'row',
        body.position ?? 'after',
      );
      const updated = tabs.update(tabId, { layout: nextLayout });
      if (updated) deps.events.emit({ type: 'tab.updated', tab: updated });
    }
    // Eager spawn: otherwise the PTY only starts when the frontend mounts
    // the XtermPane (i.e. when the user navigates to its tab). A CLI-created
    // pane with --cmd would sit idle until then. Same spec shape as ws.ts.
    const workspaceId = tabs.getWorkspaceId(tabId);
    try {
      await deps.ptyd.ensurePane({
        id: pane.id,
        shell: pane.shell ?? defaultShell,
        startup_cmd: pane.startup_cmd,
        cwd: pane.cwd ?? homedir(),
        env: pane.env,
        tab_id: tabId,
        workspace_id: workspaceId,
      });
    } catch {
      // ptyd unreachable: the pane row is committed; the runtime will be
      // created lazily when a client attaches and ptyd reconnects.
    }
    return c.json(pane, 201);
  });

  return app;
}

export function panesScopedRoutes(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);

  app.get('/:id', async (c) => {
    const p = panes.getById(c.req.param('id'));
    if (!p)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    // hasPane is an async RPC; this handler is rare (single-pane GET).
    // Fall back to false if ptyd is disconnected — the row is still
    // useful for the caller.
    let isRunning = false;
    try {
      isRunning = await deps.ptyd.hasPane(p.id);
    } catch {
      isRunning = false;
    }
    return c.json({ ...p, isRunning });
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const body = z
      .object({
        kind: z.enum(['shell', 'url']).optional(),
        url: z.string().url().nullable().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));

    if (body.kind && body.kind !== p.kind) {
      // Kind flip: close ptyd-attached clients FIRST (with code 4001) so
      // they don't see the PTY-exit close (code 1000) that killPane would
      // otherwise race ahead and emit. Then kill the PTY on ptyd. Lossy
      // by design — the new kind starts fresh.
      //
      // ptyd holds runtime state; SQLite is the source of truth. If ptyd
      // is unreachable, the DB mutation must still proceed — ptyd has no
      // persistent state, so when it reconnects it doesn't need cleanup.
      try {
        await deps.ptyd.closePtyClients(id);
      } catch {
        // ptyd disconnected; proceed with the kind flip in the DB.
      }
      try {
        await deps.ptyd.killPane(id);
      } catch {
        // ptyd disconnected; proceed — see comment above.
      }
      deps.cache.forget(id);
      if (body.kind === 'url') {
        panes.updateKind(id, { kind: 'url', url: body.url ?? null });
      } else {
        // Default shell pane: pick the host's $SHELL + $HOME so the new
        // pane is usable on next WS attach. Lazy-spawn happens on connect.
        panes.updateKind(id, {
          kind: 'shell',
          shell: process.env.SHELL ?? '/bin/zsh',
          cwd: process.env.HOME ?? '/',
        });
      }
    } else if (body.url !== undefined) {
      if (p.kind !== 'url') {
        return c.json(
          { error: { code: 'bad_request', message: 'url can only be set on kind=url panes' } },
          400,
        );
      }
      panes.updateUrl(id, body.url ?? '');
    }
    const refreshed = panes.getById(id);
    if (refreshed) {
      const decorated = {
        ...refreshed,
        attention: deps.cache.getAttention(refreshed.id),
        app_urls: deps.cache.getAppUrls(refreshed.id),
      };
      deps.events.emit({ type: 'pane.updated', tab_id: refreshed.tab_id, pane: decorated });
      return c.json(decorated);
    }
    return c.json(refreshed);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    // Capture tab_id BEFORE the delete so the event still carries it.
    const tabId = p.tab_id;
    // ptyd holds runtime state; SQLite is the source of truth. If ptyd
    // is unreachable, the DB mutation must still proceed — ptyd has no
    // persistent state, so when it reconnects it doesn't need cleanup.
    try {
      await deps.ptyd.killPane(id);
    } catch {
      // ptyd disconnected; the runtime (if any) is already gone from
      // its perspective. Proceed with the DB delete.
    }
    deps.cache.forget(id);
    panes.delete(id);
    deps.events.emit({ type: 'pane.removed', tab_id: tabId, pane_id: id });
    return c.body(null, 204);
  });

  app.post('/:id/respawn', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p)
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    if (p.kind === 'url') {
      return c.json(
        { error: { code: 'bad_request', message: 'cannot respawn a url pane' } },
        400,
      );
    }
    // ptyd holds runtime state; SQLite is the source of truth. If ptyd
    // is unreachable, swallow the kill — the second call (ensurePane)
    // below will still surface a 503 since respawn cannot proceed
    // without a fresh runtime.
    try {
      await deps.ptyd.killPane(id);
    } catch {
      // proceed to ensurePane; if ptyd is genuinely down it'll fail too.
    }
    deps.cache.forget(id);
    // p.shell / p.cwd are nullable on PaneSpec (URL panes), but we've
    // already returned early for kind === 'url' so they should be non-null
    // here. Fall back defensively in case a row is malformed.
    // workspace_id lets the respawned runtime inject MUXPAD_WORKSPACE_ID
    // into the new shell. The shared Tab shape omits workspace_id, so we
    // pull it via the dedicated TabStore helper.
    const workspaceId = tabs.getWorkspaceId(p.tab_id);
    // ensurePane after killPane is the one place a 5xx is legitimate:
    // respawn means "make this pane runnable now". If ptyd is unreachable
    // we can't start a runtime, so surface 503 to the caller.
    try {
      await deps.ptyd.ensurePane({
        id: p.id,
        shell: p.shell ?? defaultShell,
        startup_cmd: p.startup_cmd,
        cwd: p.cwd ?? process.env.HOME ?? '/',
        env: p.env,
        tab_id: p.tab_id,
        ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
      });
    } catch {
      return c.json(
        {
          error: {
            code: 'ptyd_unavailable',
            message: 'ptyd is unreachable; cannot respawn pane',
          },
        },
        503,
      );
    }
    return c.body(null, 204);
  });

  // Mark a single pane as "seen". Counterpart to /tabs/:id/seen but
  // surgical — mobile uses it on tab mount / pane switch to clear
  // attention for just the pane the user is actually looking at, so
  // other panes in the same tab can keep flagging in the pane dropdown.
  // Desktop continues to use the bulk tab-seen since the mosaic shows
  // every pane simultaneously and "seen" applies to all of them.
  app.post('/:id/seen', async (c) => {
    const id = c.req.param('id');
    if (!panes.getById(id))
      return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    try {
      await deps.ptyd.markSeen(id);
    } catch {
      // best-effort — same swallow as the tab-level seen
    }
    return c.body(null, 204);
  });

  return app;
}
