import type { LayoutNode } from '@muxpad/shared';
import {
  appendLeafToLayout,
  removeLeafFromLayout,
  spliceLayoutAtTarget,
  splitLeadingEmoji,
} from '@muxpad/shared';
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
    if (!t) return c.json({ error: { code: 'not_found', message: 'tab not found' } }, 404);
    const body = z
      .object({
        kind: z.enum(['shell', 'url']).optional(),
        url: z.string().url().nullable().optional(),
        shell: z.string().optional(),
        startup_cmd: z.string().nullable().optional(),
        cwd: z.string().optional(),
        env: z.record(z.string()).nullable().optional(),
        inherit_cwd_from: z.string().optional(),
        // Which face the pane opens on — agent panes land directly on chat.
        face: z.enum(['terminal', 'web', 'chat']).optional(),
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
        // collapse null back to undefined so safeCwd's home fallback fires.
        cwd = live ?? source.cwd ?? undefined;
      }
    }

    // The chat face is agent-pane-only (the runner is the one chat driver);
    // enforcing it at the WRITE path is what keeps stale clients and scripts
    // from re-stranding panes on a driverless chat face (migration 14 swept
    // the legacy rows once — this keeps them swept).
    if (body.face === 'chat' && !body.startup_cmd?.startsWith('muxpad agent')) {
      return c.json(
        { error: { code: 'bad_request', message: 'the chat face requires an agent pane' } },
        400,
      );
    }
    const pane = panes.create({
      tab_id: tabId,
      shell: body.shell ?? defaultShell,
      // Fall back to home if the resolved cwd (often an inherited sibling cwd)
      // no longer exists — a deleted dir makes the shell spawn fail + the pane
      // cascade-delete itself (see safeCwd).
      cwd: safeCwd(cwd),
      startup_cmd: body.startup_cmd ?? null,
      env: body.env ?? null,
      ...(body.face ? { face: body.face } : {}),
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
        cwd: safeCwd(pane.cwd),
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
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
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
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const body = z
      .object({
        kind: z.enum(['shell', 'url']).optional(),
        url: z.string().url().nullable().optional(),
        // User-given pane name for the tab-strip label. '' or null clears it
        // back to the live-derived title. Independent of kind/url edits.
        name: z.string().nullable().optional(),
        // Which face the pane shows (terminal | web | chat) + the web face's
        // URL. Server-persisted so it survives reloads and follows the user
        // across devices; the emitted pane.updated syncs other clients live.
        face: z.enum(['terminal', 'web', 'chat']).optional(),
        face_url: z.string().nullable().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));

    // Rename is orthogonal to the kind/url mutations below and never touches
    // ptyd, so apply it up front regardless of which branch runs next.
    if (body.name !== undefined) panes.setName(id, body.name);
    // Face flips likewise never touch ptyd — the terminal keeps running
    // underneath whatever face is showing.
    if (body.face !== undefined) {
      // Chat face is agent-pane-only — see the create-path guard above.
      if (body.face === 'chat' && !p.startup_cmd?.startsWith('muxpad agent')) {
        return c.json(
          { error: { code: 'bad_request', message: 'the chat face requires an agent pane' } },
          400,
        );
      }
      panes.setFace(id, body.face, body.face_url);
    } else if (body.face_url !== undefined) {
      panes.setFace(id, p.face, body.face_url);
    }

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
        // ptyd disconnected; proceed — the reaper retries the kill until
        // ptyd confirms, so no straggler pty outlives the kind flip.
        queuePaneKill(deps.db, id);
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
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    // Capture tab_id BEFORE the delete so the event still carries it.
    const tabId = p.tab_id;
    // ptyd holds runtime state; SQLite is the source of truth. If ptyd
    // is unreachable, the DB mutation must still proceed — ptyd has no
    // persistent state, so when it reconnects it doesn't need cleanup.
    try {
      await deps.ptyd.killPane(id);
    } catch {
      // ptyd disconnected/kill lost: proceed with the DB delete, but queue
      // the kill — the reaper retries until the pty is confirmed gone.
      queuePaneKill(deps.db, id);
      // (the runtime, if any, would otherwise run forever with no row.)
    }
    deps.cache.forget(id);
    panes.delete(id);
    deps.events.emit({ type: 'pane.removed', tab_id: tabId, pane_id: id });
    return c.body(null, 204);
  });

  app.post('/:id/respawn', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    if (p.kind === 'url') {
      return c.json({ error: { code: 'bad_request', message: 'cannot respawn a url pane' } }, 400);
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
        cwd: safeCwd(p.cwd),
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

  // Move a pane to a different tab in the SAME workspace. Either to an
  // existing tab (`to_tab_id`) or a freshly-created one (`new_tab: true`).
  //
  // The pane's runtime/PTY is keyed by pane id and survives untouched — only
  // SQLite (the pane's tab_id) and the two tabs' layout trees change. The
  // running shell's baked-in MUXPAD_TAB_ID env goes stale until the next
  // respawn, which only matters for new in-pane CLI invocations; we
  // deliberately don't push a live env update for v1.
  //
  // If the source tab is left with no panes, it's deleted (mirrors the
  // client-side "last pane closed → close tab" cascade). `from_tab_removed`
  // in the response tells the client whether an "undo" is still possible.
  app.post('/:id/move', async (c) => {
    const id = c.req.param('id');
    const pane = panes.getById(id);
    if (!pane) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const body = z
      .object({
        to_tab_id: z.string().optional(),
        new_tab: z.boolean().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));

    const sourceTab = tabs.getById(pane.tab_id);
    if (!sourceTab)
      return c.json({ error: { code: 'not_found', message: 'source tab not found' } }, 404);
    const workspaceId = tabs.getWorkspaceId(pane.tab_id);
    if (!workspaceId)
      return c.json({ error: { code: 'not_found', message: 'source workspace not found' } }, 404);

    const decorate = (paneId: string) => {
      const p = panes.getById(paneId);
      return p ? decoratePane(deps.cache, p) : null;
    };

    // Extracting the SOLE pane of a tab into a new tab is pure churn — it
    // would create a fresh tab and delete the old one, throwing away the
    // source tab's name/icon/slug for an identical single-pane result. Treat
    // it as a no-op so neither the UI nor a CLI caller can trash a tab's
    // identity by "extracting" its only pane. (Moving a sole pane to an
    // EXISTING tab is still allowed — that's the normal "last pane left, tab
    // closes" cascade, not identity churn.)
    if (body.new_tab && panes.listByTab(pane.tab_id).length <= 1) {
      return c.json({
        pane: decorate(id),
        from_tab_id: sourceTab.id,
        to_tab: sourceTab,
        from_tab_removed: false,
      });
    }

    // Resolve / create the destination tab.
    let destTab: typeof sourceTab;
    let createdNewTab = false;
    if (body.new_tab) {
      // Seed the new tab from the pane's live title / foreground command, so
      // an extracted pane lands in a tab that reads like its contents instead
      // of a random codename. Sanitize it: strip stray control chars, and
      // split any LEADING emoji into the tab's dedicated icon slot. Left in
      // the name, that emoji renders as a tofu box — the label font has no
      // emoji fallback (the icon column does) — and the icon slot is exactly
      // where a tab's glyph belongs (see splitLeadingEmoji / tab-icons).
      const rawTitle = (deps.cache.getTitle(id) || deps.cache.getFg(id) || '')
        // Strip control chars (\p{Cc}) AND private-use glyphs (\p{Co}) — the
        // latter are Nerd Font / Powerline icons that shells stuff into the
        // terminal title (Starship, p10k, …); they're font-private, render as
        // tofu boxes in the chrome's label font, and are never meaningful text.
        .replace(/[\p{Cc}\p{Co}]/gu, '')
        .trim();
      const { icon: leadingIcon, rest } = splitLeadingEmoji(rawTitle);
      const seedName = rest.trim() || randomWorkspaceName();
      destTab = tabs.create({
        name: seedName,
        layout: id,
        workspace_id: workspaceId,
        ...(leadingIcon ? { icon: leadingIcon } : {}),
      });
      createdNewTab = true;
    } else {
      if (!body.to_tab_id)
        return c.json(
          { error: { code: 'bad_request', message: 'to_tab_id or new_tab required' } },
          400,
        );
      const t = tabs.getById(body.to_tab_id);
      if (!t)
        return c.json({ error: { code: 'not_found', message: 'destination tab not found' } }, 404);
      // Cross-workspace moves are allowed — a pane's home is pure metadata
      // (ptys and agent runners key by pane id, so nothing running notices),
      // and the sidebar drop targets naturally span workspaces.
      destTab = t;
    }

    // No-op move (same tab). For new_tab this can't happen; for an explicit
    // to_tab_id it can, so short-circuit before mutating anything.
    if (destTab.id === sourceTab.id) {
      return c.json({
        pane: decorate(id),
        from_tab_id: sourceTab.id,
        to_tab: destTab,
        from_tab_removed: false,
      });
    }

    // Reparent the pane row, then fix up both layout trees.
    panes.setTab(id, destTab.id);

    let finalDest = destTab;
    if (!createdNewTab) {
      finalDest = tabs.update(destTab.id, { layout: appendLeafToLayout(destTab.layout, id) });
    }

    const sourceLayout = removeLeafFromLayout(sourceTab.layout, id);
    const sourceEmpty = sourceLayout === '' || sourceLayout == null;

    // Emit destination events first so a client already viewing the dest tab
    // has the pane in its list before the layout referencing it lands.
    const decorated = decorate(id);
    if (createdNewTab) {
      // tab.added carries the full tab (layout already = the moved pane), so
      // the dest is fully described in one event; no separate pane.added.
      deps.events.emit({ type: 'tab.added', workspace_id: workspaceId, tab: finalDest });
    } else {
      if (decorated) deps.events.emit({ type: 'pane.added', tab_id: destTab.id, pane: decorated });
      deps.events.emit({ type: 'tab.updated', tab: finalDest });
    }

    // Then the source side.
    deps.events.emit({ type: 'pane.removed', tab_id: sourceTab.id, pane_id: id });
    if (sourceEmpty) {
      // The pane already moved out (its tab_id points at dest), so the
      // ON DELETE CASCADE won't touch it — only the now-empty source row goes.
      tabs.delete(sourceTab.id);
      deps.events.emit({ type: 'tab.removed', workspace_id: workspaceId, tab_id: sourceTab.id });
    } else {
      const updatedSource = tabs.update(sourceTab.id, { layout: sourceLayout });
      deps.events.emit({ type: 'tab.updated', tab: updatedSource });
    }

    return c.json({
      pane: decorated,
      from_tab_id: sourceTab.id,
      // Movers need the SOURCE workspace to refresh its tab cache — with
      // cross-workspace moves the caller only knows the destination's.
      from_workspace_id: workspaceId,
      to_tab: finalDest,
      from_tab_removed: sourceEmpty,
    });
  });

  return app;
}
