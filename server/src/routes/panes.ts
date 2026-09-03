import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AgentMode, LayoutNode, PaneSpec } from '@muxpad/shared';
import {
  AgentModeSchema,
  appendLeafToLayout,
  removeLeafFromLayout,
  spliceLayoutAtTarget,
  splitLeadingEmoji,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentBridge } from '../agent-bridge.js';
import { applyModeToStartupCmd } from '../agent-modes.js';
import { agentStartupCmd } from '../agent-tab.js';
import { agentPaneHasMessages } from '../chat/has-messages.js';
import type { EventBus } from '../events.js';
import { queuePaneKill } from '../pane-reaper.js';
import { agentCwd, hasProjectContext } from '../project-root.js';
import { type PtydCache, decoratePane, decorateTab } from '../ptyd-cache.js';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { randomWorkspaceName } from '../random-name.js';
import { safeCwd } from '../safe-cwd.js';
import { AgentQueueStore } from '../store/AgentQueueStore.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import type { TabActivity } from '../tab-activity.js';
import { classifyUrlHost, probeUrlHealth } from '../url-health.js';

const defaultShell = process.env.SHELL ?? '/bin/zsh';

/**
 * Same RESOURCE, allowing only for the cosmetic drift between how a URL was
 * recorded and how the client asks about it (a trailing slash, a default port
 * spelled out, host case).
 *
 * The query string IS part of the comparison. It used to be ignored "because it
 * doesn't change which server answers" — true for liveness, false for safety:
 * that let a declared `…/admin` authorize a probe of `…/admin?delete=true`,
 * turning the health endpoint into a one-request side-effect trigger. The
 * fragment is not compared because it is never sent on the wire.
 *
 * Falls back to exact string equality for anything unparseable.
 */
function sameUrl(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => (u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname);
    return x.origin === y.origin && path(x) === path(y) && x.search === y.search;
  } catch {
    return false;
  }
}

/** Scheme + host + port, or null when unparseable. Case/default-port
 *  normalization comes free from `URL.origin`. */
function originOf(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/**
 * May this pane be converted into something else (a different harness, a
 * plain terminal, a web view)? Returns null when it may, or the human reason
 * it may not.
 *
 * THREE conditions, all enforced here rather than in the UI:
 *
 *  1. It must be an AGENT pane. The gate used to be the exact literal
 *     `muxpad agent --pick`, because conversion existed only for the old
 *     "What do you want to open?" chooser screen. That screen is gone — a new
 *     tab opens straight into the house chat — so requiring `--pick` made the
 *     "open instead: …" strip 409 on every click. Any `muxpad agent` pane
 *     qualifies now; a terminal someone is working in still does not.
 *
 *  2. It must have NO MESSAGES. Conversion kills the runner and respawns, so
 *     it is destructive to a real conversation. We do NOT delegate this to
 *     the client: the strip only renders on a chat that LOOKS empty, but
 *     history replays asynchronously, so an existing conversation reads as
 *     empty for a beat on every reconnect. A click in that window must not be
 *     able to destroy a session, and only the server can promise that.
 *
 *  3. NO TURN MAY BE IN FLIGHT. Condition 2 looks at the transcript, which the
 *     harness writes only as the turn produces records — so between "user hits
 *     send on their phone" and "the first user record is on disk" the chat is
 *     message-free on paper while a real turn is running. A conversion landing
 *     in that window (the same chat still open on the laptop, showing the empty
 *     state and its strip) kills the runner mid-turn. `turnActive` is the live
 *     registry's answer and `agent_sessions.status` is its persisted mirror;
 *     either saying "running" is enough to refuse.
 */
function conversionRefusal(
  db: Database.Database,
  p: PaneSpec,
  bridge?: AgentBridge | undefined,
): { code: string; message: string } | null {
  if (p.kind !== 'shell' || !(p.startup_cmd?.startsWith('muxpad agent') ?? false)) {
    return { code: 'not_an_agent', message: 'only an agent chat can be converted' };
  }
  // The CODE matters, not just the sentence. The client's empty state decides
  // what it believes about this chat from the answer: `has_messages` is the
  // server correcting our "this chat is empty" render (so the offer must
  // retire), while `mid_turn` is a WAIT — the chat really is empty and the
  // offer should come back when the turn ends. Sniffing the prose to tell
  // those apart would break the first time the wording improved.
  if (agentPaneHasMessages(db, p.id)) {
    return {
      code: 'has_messages',
      message: 'this chat already has messages — open a new tab instead',
    };
  }
  const live = bridge?.turnActive(p.id) === true;
  const persisted = new AgentSessionStore(db).getByPane(p.id)?.status === 'running';
  if (live || persisted) {
    return {
      code: 'mid_turn',
      message: 'this chat is mid-turn — wait for it to finish, or open a new tab',
    };
  }
  return null;
}

// A pane URL lands in an <iframe src> with `allow-scripts allow-same-origin`.
// z.string().url() alone accepts `javascript:`/`data:`/`file:` schemes, so pin
// to http(s): the only schemes a web-face pane is ever meant to load, and the
// ones that can't smuggle an inline-script or local-file payload into the frame.
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: 'url must be http(s)' });

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
    const parsed = z
      .object({
        kind: z.enum(['shell', 'url']).optional(),
        url: httpUrl.nullable().optional(),
        shell: z.string().optional(),
        startup_cmd: z.string().nullable().optional(),
        cwd: z.string().optional(),
        env: z.record(z.string()).nullable().optional(),
        inherit_cwd_from: z.string().optional(),
        // Which face the pane opens on — agent panes land directly on chat.
        face: z.enum(['terminal', 'web', 'chat']).optional(),
        // Behavior overlay for an agent pane: 'do' = the house chat (carries
        // the <dataDir>/do-mode.md contract), 'deep' = a raw session of the
        // harness with capabilities injection only. Internal plumbing — the
        // UI never names these; it offers "the house chat" vs "Claude /
        // Codex / Cursor".
        mode: AgentModeSchema.optional(),
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
      // safeParse (not parse): a rejected field — notably a non-http(s) url —
      // must surface as a clean 400, not bubble to Hono's default 500.
      .safeParse(await c.req.json().catch(() => ({})));
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
      deps.events.emit({ type: 'pane.added', tab_id: tabId, pane: decoratePane(deps.cache, pane) });
      if (body.append_to_layout) {
        const nextLayout = appendPaneToLayout(
          t.layout,
          body.split_from ?? null,
          pane.id,
          body.direction ?? 'row',
          body.position ?? 'after',
        );
        const updated = tabs.update(tabId, { layout: nextLayout });
        if (updated)
          deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, updated) });
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
    // Fall back to home if the resolved cwd (often an inherited sibling cwd) no
    // longer exists — a deleted dir makes the shell spawn fail + the pane
    // cascade-delete itself (see safeCwd). For an AGENT pane, snap up to the git
    // root so it starts with project context (rules/MCP), not a random subdir.
    const isAgent = body.face === 'chat' || (body.startup_cmd?.startsWith('muxpad agent') ?? false);
    const resolvedCwd = isAgent ? agentCwd(safeCwd(cwd)) : safeCwd(cwd);
    const pane = panes.create({
      tab_id: tabId,
      shell: body.shell ?? defaultShell,
      cwd: resolvedCwd,
      startup_cmd: body.startup_cmd ?? null,
      env: body.env ?? null,
      ...(body.face ? { face: body.face } : {}),
      ...(isAgent && body.mode ? { mode: body.mode } : {}),
    });
    deps.events.emit({ type: 'pane.added', tab_id: tabId, pane: decoratePane(deps.cache, pane) });
    if (body.append_to_layout) {
      const nextLayout = appendPaneToLayout(
        t.layout,
        body.split_from ?? null,
        pane.id,
        body.direction ?? 'row',
        body.position ?? 'after',
      );
      const updated = tabs.update(tabId, { layout: nextLayout });
      if (updated)
        deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, updated) });
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
  /** Late-bound relay into the live runner registry — used to tell a running
   *  agent that its mode changed. Optional: without it a mode PATCH still
   *  persists and still takes full effect on the next respawn. */
  agentBridge?: AgentBridge;
  /** Only used to drop a deleted/moved pane's activity memo. */
  tabActivity?: TabActivity;
}): Hono {
  const app = new Hono();
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  // Only for validating a `new_tab` move's destination workspace (below).
  const workspaces = new WorkspaceStore(deps.db);

  // Flat enumeration: every pane across all VISIBLE workspaces, decorated, each
  // row joined with its tab/workspace id+name. A supervisor's "org chart" view —
  // without this a caller must fan out over workspaces → tabs → panes.
  //
  // Hidden system containers are excluded unless `?all=1`, the same convention
  // (and the same reason) as GET /api/workspaces. This is not cosmetic: a
  // registered app is a pane in the hidden apps container, the universal agent
  // instructions point agents at `muxpad pane list --all` as "the map", and the
  // very next verb they are taught is `muxpad pane send <id>`. Listing an app's
  // pane here invites an agent to type keystrokes into a running web server —
  // for something it has no business touching, since `muxpad app` is the verb
  // for apps. `?all=1` keeps the escape hatch for debugging a stuck pty.
  app.get('/', async (c) => {
    const includeHidden = c.req.query('all') === '1';
    const rows = deps.db
      .prepare(
        `SELECT p.id AS pane_id, t.id AS tab_id, t.name AS tab_name,
                w.id AS workspace_id, w.name AS workspace_name
         FROM panes p
         JOIN tabs t ON t.id = p.tab_id
         JOIN workspaces w ON w.id = t.workspace_id
         ${includeHidden ? '' : 'WHERE w.hidden = 0'}
         ORDER BY w.position ASC, w.created_at ASC,
                  t.position ASC, t.created_at ASC,
                  p.created_at ASC`,
      )
      .all() as Array<{
      pane_id: string;
      tab_id: string;
      tab_name: string;
      workspace_id: string;
      workspace_name: string;
    }>;
    // One listPanes RPC instead of a hasPane per row; if ptyd is unreachable
    // every pane reads as not running — the rows themselves are still useful.
    let live: Set<string>;
    try {
      live = new Set(await deps.ptyd.listPanes());
    } catch {
      live = new Set();
    }
    const out = [];
    for (const r of rows) {
      const p = panes.getById(r.pane_id);
      if (!p) continue; // raced a delete between the join and the fetch
      out.push({
        ...decoratePane(deps.cache, p),
        // Live shell cwd when ptyd has reported one; else the spawn cwd row.
        cwd: deps.cache.getCwd(p.id) ?? p.cwd,
        isRunning: live.has(p.id),
        tab_id: r.tab_id,
        tab_name: r.tab_name,
        workspace_id: r.workspace_id,
        workspace_name: r.workspace_name,
      });
    }
    return c.json(out);
  });

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
    // Decorated (title/fg/attention/busy/app_urls) like the flat list — the
    // web's pinned rows seed their badges from this single-pane GET.
    return c.json({ ...decoratePane(deps.cache, p), isRunning });
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const body = z
      .object({
        kind: z.enum(['shell', 'url']).optional(),
        url: httpUrl.nullable().optional(),
        // User-given pane name for the tab-strip label. '' or null clears it
        // back to the live-derived title. Independent of kind/url edits.
        name: z.string().nullable().optional(),
        // Which face the pane shows (terminal | web | chat) + the web face's
        // URL. Server-persisted so it survives reloads and follows the user
        // across devices; the emitted pane.updated syncs other clients live.
        face: z.enum(['terminal', 'web', 'chat']).optional(),
        // Same iframe sink as `url`, so same http(s) gate — but '' / null are
        // the legitimate "clear the web face" signals and must pass through.
        face_url: httpUrl.or(z.literal('')).nullable().optional(),
        // Agent behavior mode (⚡ do / 🧠 deep). See the handler below for the
        // mid-session semantics — deliberately NOT a respawn.
        mode: AgentModeSchema.optional(),
      })
      // safeParse (not parse): a rejected url/face_url must 400, not 500.
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json(
        {
          error: { code: 'bad_request', message: body.error.issues[0]?.message ?? 'invalid body' },
        },
        400,
      );
    const patch = body.data;

    // ── VALIDATE EVERYTHING FIRST, THEN MUTATE ──────────────────────────────
    // This handler used to interleave the two: `{name:'renamed', mode:'do'}`
    // against a non-agent pane persisted the rename and THEN returned 400, so
    // the caller saw a failure while half its patch had landed and no
    // pane.updated was emitted to tell anyone. A PATCH is one edit — it applies
    // whole or not at all. Every semantic check runs here, before the first
    // write; the writes themselves go in one transaction below.
    const isAgentPane = p.face === 'chat' || (p.startup_cmd?.startsWith('muxpad agent') ?? false);
    const modeChanged = patch.mode !== undefined && patch.mode !== p.mode;
    if (modeChanged && !isAgentPane) {
      return c.json(
        { error: { code: 'bad_request', message: 'mode applies to agent panes only' } },
        400,
      );
    }
    if (patch.face === 'chat' && !p.startup_cmd?.startsWith('muxpad agent')) {
      // Chat face is agent-pane-only — see the create-path guard above.
      return c.json(
        { error: { code: 'bad_request', message: 'the chat face requires an agent pane' } },
        400,
      );
    }
    const kindFlip = patch.kind !== undefined && patch.kind !== p.kind;
    if (!kindFlip && patch.url !== undefined && p.kind !== 'url') {
      return c.json(
        { error: { code: 'bad_request', message: 'url can only be set on kind=url panes' } },
        400,
      );
    }

    // ── ptyd side effects (async — a better-sqlite3 transaction is strictly
    //    synchronous, so nothing that awaits may sit inside the commit below).
    if (kindFlip) {
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
    }

    // ── COMMIT: all-or-nothing.
    //
    // MODE, MID-SESSION SEMANTICS, stated honestly (see agent-modes.ts for the
    // harness-by-harness evidence): NO harness lets us rewrite a live
    // session's system prompt. So this endpoint does exactly two things and
    // does NOT respawn the pane (that would kill the conversation, background
    // subagents and scheduled wakeups — far too violent for a toggle):
    //   1. persists the mode and rewrites `startup_cmd`, so the very next
    //      respawn boots with the real system-prompt-level overlay; and
    //   2. relays a `mode` frame to the live runner (after the commit), which
    //      prepends ONE delimited <muxpad-mode> note to the next user message.
    // The live turn therefore gets an in-conversation instruction, not a new
    // system prompt — weaker, and it can drift over a long session. That's
    // the true behavior, so it's what we implement and document.
    deps.db.transaction(() => {
      if (patch.name !== undefined) panes.setName(id, patch.name);
      if (modeChanged) {
        const nextMode: AgentMode = patch.mode as AgentMode;
        panes.setMode(id, nextMode);
        const nextCmd = applyModeToStartupCmd(p.startup_cmd, nextMode);
        if (nextCmd !== p.startup_cmd) panes.setStartupCmd(id, nextCmd);
      }
      // Face flips never touch ptyd — the terminal keeps running underneath
      // whatever face is showing.
      if (patch.face !== undefined) panes.setFace(id, patch.face, patch.face_url);
      else if (patch.face_url !== undefined) panes.setFace(id, p.face, patch.face_url);
      if (kindFlip) {
        if (patch.kind === 'url') {
          panes.updateKind(id, { kind: 'url', url: patch.url ?? null });
        } else {
          // Default shell pane: pick the host's $SHELL + $HOME so the new
          // pane is usable on next WS attach. Lazy-spawn happens on connect.
          panes.updateKind(id, {
            kind: 'shell',
            shell: process.env.SHELL ?? '/bin/zsh',
            cwd: process.env.HOME ?? '/',
          });
        }
      } else if (patch.url !== undefined) {
        panes.updateUrl(id, patch.url ?? '');
      }
    })();
    // Live relay only after the row is committed, so the runner is never told
    // about a mode the DB rolled back.
    if (modeChanged) deps.agentBridge?.setMode(id, patch.mode as AgentMode);

    const refreshed = panes.getById(id);
    if (refreshed) {
      // Every pane.updated goes through decoratePane — no route hand-builds
      // the payload. A partial event here used to blank `busy` on the client
      // (TabView coalesces from the previous row, and an absent field reads as
      // undefined), so a face switch / rename mid-turn killed the spinner until
      // the next busy EDGE. It also poisoned the sidebar's (busy,attention)
      // dedup signature, swallowing the real busy→false edge afterwards.
      const decorated = decoratePane(deps.cache, refreshed);
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
    // Row FIRST, cache second. `cache.forget` fires 'paneRemoved', whose
    // subscriber emits a decorated `pane.updated` for any pane whose row still
    // exists — so forgetting before the delete announced an update for a pane
    // we were about to remove. Deleting first makes that lookup miss, and
    // `pane.removed` below is the only event this path produces.
    panes.delete(id);
    deps.cache.forget(id);
    deps.tabActivity?.forgetPane(id);
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

  /**
   * Real health of a pane's web-face URL, probed FROM THE SERVER.
   *
   * The browser's own probe (`fetch(mode:'no-cors')`) can only tell "something
   * accepted the connection" from "nothing did" — an opaque response has no
   * readable status. Behind `tailscale serve` that is the wrong question: the
   * public port stays open when the local backend dies and answers 502, so the
   * browser sees "alive" and the user gets a silent blank iframe. The server
   * shares a machine with the app, so it can read the status and say what is
   * actually true. See url-health.ts.
   *
   * SSRF GUARD AND ITS RESIDUAL TRUST MODEL
   * ---------------------------------------
   * This endpoint makes the server issue a GET, so it must not become a blind
   * proxy. The allowlist has TWO sources, and they are trusted differently:
   *
   *  A. DECLARED — the pane's own DB-persisted `url` / `face_url`. Someone had
   *     to WRITE these. Match must be exact: origin + path + QUERY (sameUrl).
   *     Query used to be ignored, which let a declared `…/admin` authorize
   *     `…/admin?delete=true` — a probe is a real request, so an allowlist that
   *     ignores the query allows side effects. The exact URL is probed.
   *
   *  B. DETECTED — app URLs muxpad scraped out of the pane's OUTPUT. No write
   *     is needed to get a string in there: a pane prints whatever it prints
   *     (an agent `cat`s a file, a `curl` echoes a hostile page), and the
   *     scanner captures the full path AND query (runtime/pty-scanner.ts). So
   *     these authorize by ORIGIN ONLY, and we probe `<origin>/` — never the
   *     caller's path. Liveness is a property of the SERVER, not of a path;
   *     "is anything answering on this origin, and is it a 502 from a proxy
   *     whose backend died" is exactly the question, and the root answers it.
   *     A planted `http://127.0.0.1:2019/config/apps/...` therefore buys a GET
   *     of `http://127.0.0.1:2019/` and nothing more.
   *
   * On top of both:
   *
   *  C. Link-local and cloud-metadata targets (169.254.0.0/16 — including
   *     169.254.169.254 — fe80::/10, metadata.google.internal, …) are refused
   *     unconditionally. No muxpad pane legitimately faces one.
   *  D. A PRIVATE target (RFC1918, CGNAT, .local/.internal, ULA, bare intranet
   *     names) needs a DECLARED match — detection cannot authorize it. Loopback
   *     and public origins may come from detection: those are the two shapes an
   *     app URL really takes. NOTE loopback detected URLs must keep working and
   *     so must PUBLIC ones — `toReachableUrl` rewrites every localhost app URL
   *     to `https://<tailnet-name>:port` before it reaches the cache, so a
   *     loopback-only rule silently 403'd every real install and put the web
   *     face back on the browser's blind probe, i.e. back on the exact 502 bug
   *     this endpoint exists to fix.
   *
   * What this does NOT claim: the API has no auth (tailnet-only is the access
   * boundary, config.ts), and anyone who can PATCH a pane can also CREATE a
   * shell pane that runs arbitrary commands — so against a caller who can
   * write, an SSRF guard is not a boundary and pretending otherwise would be
   * theatre. What these rules do contain is the READ-ONLY drive-by: a cross-
   * origin page in the user's browser can emit a bare GET (no preflight) but
   * cannot first perform the write that declares a target, cannot choose the
   * path for a scraped one, and cannot read the response. Hostnames are not
   * resolved, so a public name pointing at a private address is classified
   * 'public'; it still has to be declared or detected.
   */
  app.get('/:id/url-health', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const requested = c.req.query('url') ?? p.face_url ?? p.url;
    if (!requested) {
      return c.json({ error: { code: 'bad_request', message: 'pane has no url to probe' } }, 400);
    }
    const hostClass = classifyUrlHost(requested);
    if (hostClass === null || hostClass === 'link_local') {
      return c.json(
        { error: { code: 'forbidden', message: 'refusing to probe this address' } },
        403,
      );
    }
    // (A) declared → probe exactly what was asked for.
    let target: string | null = [p.url, p.face_url].some((k) => sameUrl(k, requested))
      ? requested
      : null;
    // (B) detected → origin match, origin-root probe. Not for private targets (D).
    if (target === null && hostClass !== 'private') {
      const origin = originOf(requested);
      if (origin && deps.cache.getAppUrls(id).some((a) => originOf(a.url) === origin)) {
        target = `${origin}/`;
      }
    }
    if (target === null) {
      return c.json(
        { error: { code: 'forbidden', message: 'url is not one of this pane’s urls' } },
        403,
      );
    }
    return c.json(await probeUrlHealth(target));
  });

  // Choose the agent harness for a pending ('muxpad agent --pick') pane. The
  // harness picker lives in the chat page; picking one lands here, which rewrites
  // the pane's startup_cmd to the chosen backend and respawns it so the real
  // runner starts. Backend is an allowlisted enum → safe in the shell string.
  app.post('/:id/agent-backend', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    // Any EMPTY agent chat can be (re)assigned a harness — see
    // conversionRefusal for the two conditions and why the zero-message one
    // is enforced server-side rather than trusted from the UI.
    const refusal = conversionRefusal(deps.db, p, deps.agentBridge);
    if (refusal) return c.json({ error: refusal }, 409);
    const body = z
      .object({
        backend: z.enum(['claude', 'codex', 'cursor']),
        // Which behavior overlay the new session runs. Omitted = keep the
        // pane's current one (the legacy harness-picker path, where the pane
        // was created with its mode already decided). The "open a RAW
        // session instead" affordance passes 'deep' explicitly: a raw
        // harness is exactly the harness, with no house contract on top.
        mode: AgentModeSchema.optional(),
        // Where the session starts. The launch picker offers this at the
        // moment of choosing — the one moment the user is actually thinking
        // about it — instead of deferring it to a menu they must already know
        // exists. Omitted = keep the pane's current folder.
        cwd: z.string().min(1).optional(),
        // Which model to pin. Baked into `startup_cmd`, which runs through a
        // shell, so the charset is gated exactly as the tabs route gates it:
        // ids like 'claude-opus-4-8[1m]' pass, shell metacharacters cannot.
        // Omitted = no `--model` flag = whatever the harness's own default is.
        // The leading-dash exclusion is not cosmetic: the charset alone admits
        // `--dangerously-skip-permissions`, which reaches the runner as
        // `muxpad agent --model '--dangerously-skip-permissions'` and is taken
        // as the model VALUE. Not RCE (the value is single-quoted and the
        // charset has no quote, space, $ or backtick), but a flag-shaped model
        // is never a real model, so reject the shape outright.
        model: z
          .string()
          .regex(/^[A-Za-z0-9._[\]-]{1,64}$/)
          .refine((m) => !m.startsWith('-'), 'a model id cannot start with "-"')
          .optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: 'backend must be claude|codex|cursor (and model must be a plain model id)',
          },
        },
        400,
      );
    const backend = body.data.backend;
    const nextMode: AgentMode = body.data.mode ?? p.mode;
    // Resolve the folder BEFORE anything is killed: a bad path must 400 with
    // the pane still running, not leave it dead between a kill and a refused
    // respawn. Same rules as POST /:id/cwd — expand `~`, require absolute,
    // require an existing directory — then snap to the project root so the
    // session lands with its rules/MCP/repo, as every other agent spawn does.
    let nextCwd = p.cwd;
    if (body.data.cwd !== undefined) {
      const dir = body.data.cwd.replace(/^~(?=\/|$)/, homedir());
      if (!dir.startsWith('/'))
        return c.json(
          { error: { code: 'bad_request', message: 'cwd must be an absolute path' } },
          400,
        );
      try {
        if (!statSync(dir).isDirectory()) throw new Error('not a dir');
      } catch {
        return c.json({ error: { code: 'bad_request', message: `not a directory: ${dir}` } }, 400);
      }
      nextCwd = agentCwd(dir);
    }
    const startupCmd = agentStartupCmd({
      backend,
      mode: nextMode,
      ...(body.data.model !== undefined ? { model: body.data.model } : {}),
    });
    const workspaceId = tabs.getWorkspaceId(p.tab_id);
    // SPAWN FIRST, PERSIST AFTER. The conversion used to be written to the DB
    // before ensurePane, so a ptyd outage returned 503 with the row ALREADY
    // converted and no `pane.updated` emitted: the client stayed on the old UI,
    // the DB described something else, and retrying 409'd because the pane no
    // longer matched the gate. Now a failed spawn leaves the pane exactly as it
    // was — the sweep respawns it from its unchanged row — and the conversion
    // only becomes true once the new runtime exists.
    try {
      await deps.ptyd.killPane(id);
    } catch {
      // proceed; ensurePane surfaces the failure if ptyd is down
    }
    deps.cache.forget(id);
    try {
      await deps.ptyd.ensurePane({
        id: p.id,
        shell: p.shell ?? defaultShell,
        startup_cmd: startupCmd,
        cwd: safeCwd(nextCwd),
        env: p.env,
        tab_id: p.tab_id,
        ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
      });
    } catch {
      return c.json(
        {
          error: {
            code: 'ptyd_unavailable',
            message: 'ptyd is unreachable; cannot start the agent',
          },
        },
        503,
      );
    }
    deps.db.transaction(() => {
      if (nextMode !== p.mode) panes.setMode(id, nextMode);
      panes.setStartupCmd(id, startupCmd);
      panes.setFace(id, 'chat');
      if (nextCwd !== p.cwd && nextCwd) {
        panes.updateCwd(id, nextCwd);
        // A different folder is a different project: anything queued against
        // the old one must not drain into the new session. Same reasoning as
        // POST /:id/cwd, which is the other way a pane changes folder.
        new AgentQueueStore(deps.db).clear(id);
      }
    })();
    const refreshed = panes.getById(id);
    if (refreshed)
      deps.events.emit({
        type: 'pane.updated',
        tab_id: refreshed.tab_id,
        pane: decoratePane(deps.cache, refreshed),
      });
    return c.body(null, 204);
  });

  // Convert an EMPTY agent chat into a plain terminal. Same gate as
  // agent-backend (conversionRefusal), so we never wipe a conversation or a
  // shell someone is working in. Clears startup_cmd, flips face to terminal,
  // respawns so the user lands on a normal PTY.
  app.post('/:id/as-terminal', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const refusal = conversionRefusal(deps.db, p, deps.agentBridge);
    if (refusal) return c.json({ error: refusal }, 409);
    const workspaceId = tabs.getWorkspaceId(p.tab_id);
    // Spawn first, persist after — see the note on /agent-backend. A 503 here
    // must leave the pane an agent chat, not a half-converted row the client
    // can't recover from without a reload.
    try {
      await deps.ptyd.killPane(id);
    } catch {
      // proceed; ensurePane surfaces the failure if ptyd is down
    }
    deps.cache.forget(id);
    try {
      await deps.ptyd.ensurePane({
        id: p.id,
        shell: p.shell ?? defaultShell,
        startup_cmd: null,
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
            message: 'ptyd is unreachable; cannot start the terminal',
          },
        },
        503,
      );
    }
    deps.db.transaction(() => {
      panes.setStartupCmd(id, null);
      panes.setFace(id, 'terminal');
    })();
    const refreshed = panes.getById(id);
    if (refreshed)
      deps.events.emit({
        type: 'pane.updated',
        tab_id: refreshed.tab_id,
        pane: decoratePane(deps.cache, refreshed),
      });
    return c.body(null, 204);
  });

  // Convert an EMPTY agent chat into a blank URL pane. UrlPaneTitle
  // auto-focuses an empty URL field when url is null. Same gate as
  // as-terminal / agent-backend (conversionRefusal).
  app.post('/:id/as-web', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    const refusal = conversionRefusal(deps.db, p, deps.agentBridge);
    if (refusal) return c.json({ error: refusal }, 409);
    try {
      await deps.ptyd.closePtyClients(id);
    } catch {
      // ptyd disconnected; proceed with the kind flip in the DB.
    }
    try {
      await deps.ptyd.killPane(id);
    } catch {
      queuePaneKill(deps.db, id);
    }
    deps.cache.forget(id);
    panes.updateKind(id, { kind: 'url', url: null, startup_cmd: null });
    const refreshed = panes.getById(id);
    if (refreshed)
      deps.events.emit({
        type: 'pane.updated',
        tab_id: refreshed.tab_id,
        pane: decoratePane(deps.cache, refreshed),
      });
    return c.body(null, 204);
  });

  // Change a pane's working directory and respawn it there (the folder switcher
  // in the chat header). For an agent pane we snap to the git root so it lands
  // with project context. Restarts the process — the caller expects that.
  app.post('/:id/cwd', async (c) => {
    const id = c.req.param('id');
    const p = panes.getById(id);
    if (!p) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    if (p.kind !== 'shell')
      return c.json({ error: { code: 'bad_request', message: 'not a shell pane' } }, 400);
    const body = z
      .object({ cwd: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json({ error: { code: 'bad_request', message: 'cwd required' } }, 400);
    let dir = body.data.cwd.replace(/^~(?=\/|$)/, homedir()); // expand a leading ~
    // Require an ABSOLUTE path: a relative one would resolve against the server
    // process cwd here but ptyd's cwd at spawn — different dirs.
    if (!dir.startsWith('/'))
      return c.json(
        { error: { code: 'bad_request', message: 'cwd must be an absolute path' } },
        400,
      );
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not a dir');
    } catch {
      return c.json({ error: { code: 'bad_request', message: `not a directory: ${dir}` } }, 400);
    }
    const isAgent = p.face === 'chat' || (p.startup_cmd?.startsWith('muxpad agent') ?? false);
    let startupCmd = p.startup_cmd;
    if (isAgent) {
      dir = agentCwd(dir);
      // Start a FRESH session in the new folder: resuming the old session in a
      // different cwd fails for Claude (its transcript is cwd-keyed) and is
      // semantically wrong — a new folder is a new project. Drop --resume/--pick,
      // keep the chosen --backend; the runner re-hellos a new sid and self-heals.
      const backendMatch = p.startup_cmd?.match(/--backend (claude|codex|cursor)/);
      // The pane's MODE survives the folder switch — it's a property of how
      // you want this pane to behave, not of the session being restarted.
      startupCmd =
        applyModeToStartupCmd(
          `muxpad agent${backendMatch ? ` --backend ${backendMatch[1]}` : ''}`,
          p.mode,
        ) ?? `muxpad agent${backendMatch ? ` --backend ${backendMatch[1]}` : ''}`;
      panes.setStartupCmd(id, startupCmd);
      // Switching folders starts a fresh session in a NEW project context —
      // messages queued against the old folder must not drain into it. Drop
      // them; the respawn's re-hello re-broadcasts the (now empty) queue to
      // open chat views via the refreshed session frame.
      new AgentQueueStore(deps.db).clear(id);
    }
    panes.updateCwd(id, dir);
    const workspaceId = tabs.getWorkspaceId(p.tab_id);
    try {
      await deps.ptyd.killPane(id);
    } catch {
      // proceed; ensurePane surfaces the failure
    }
    deps.cache.forget(id);
    try {
      await deps.ptyd.ensurePane({
        id: p.id,
        shell: p.shell ?? defaultShell,
        startup_cmd: startupCmd,
        cwd: dir,
        env: p.env,
        tab_id: p.tab_id,
        ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
      });
    } catch {
      return c.json(
        {
          error: { code: 'ptyd_unavailable', message: 'ptyd is unreachable; cannot switch folder' },
        },
        503,
      );
    }
    const refreshed = panes.getById(id);
    if (refreshed)
      deps.events.emit({
        type: 'pane.updated',
        tab_id: refreshed.tab_id,
        pane: decoratePane(deps.cache, refreshed),
      });
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
    const pane = panes.getById(id);
    if (!pane) return c.json({ error: { code: 'not_found', message: 'pane not found' } }, 404);
    // Viewing clears both read-state flags: the "done, unreviewed" bold
    // (persisted) and the BEL red dot (ptyd runtime). Emit pane.updated so the
    // bold drops immediately instead of waiting for the next nav poll.
    if (pane.unread) {
      panes.setUnread(id, false);
      const refreshed = panes.getById(id);
      if (refreshed)
        deps.events.emit({
          type: 'pane.updated',
          tab_id: refreshed.tab_id,
          pane: decoratePane(deps.cache, refreshed),
        });
    }
    // D12: `unread` was UNCLEARABLE FROM MOBILE. Mobile takes this surgical
    // per-pane route (so other panes can keep flagging in the pane list), and
    // it never touched the TAB's own manual unread mark — so a "Mark as unread"
    // from the sheet's ⋯ menu persisted until you next opened the tab on a
    // desktop. Clear it once nothing in the tab is unread any more, which is
    // exactly the moment the tab-level bold stops meaning anything.
    if (tabs.isUnread(pane.tab_id)) {
      const stillUnread = panes.listByTab(pane.tab_id).some((p) => p.unread);
      if (!stillUnread) tabs.setUnread(pane.tab_id, false);
    }
    try {
      await deps.ptyd.markSeen(id);
    } catch {
      // best-effort — same swallow as the tab-level seen
    }
    return c.body(null, 204);
  });

  // Move a pane to a different tab. Either to an existing tab (`to_tab_id`,
  // any workspace) or a freshly-created one (`new_tab: true`, in the source's
  // workspace unless `to_workspace_id` names another — that's the sidebar's
  // "drag a pane onto a workspace header" gesture).
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
        /** Only meaningful with `new_tab`: which workspace the new tab lands in. */
        to_workspace_id: z.string().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));

    const sourceTab = tabs.getById(pane.tab_id);
    if (!sourceTab)
      return c.json({ error: { code: 'not_found', message: 'source tab not found' } }, 404);
    const workspaceId = tabs.getWorkspaceId(pane.tab_id);
    if (!workspaceId)
      return c.json({ error: { code: 'not_found', message: 'source workspace not found' } }, 404);
    // Where a `new_tab` lands. Defaults to the source's workspace (the old
    // behaviour); an explicit id must exist and be a real, listed workspace,
    // or the tab would be created somewhere nothing shows it. Only consulted
    // on the new_tab path — a `to_tab_id` move already names its destination,
    // and rejecting it over a stale companion field would refuse a legal move.
    let destWorkspaceId = workspaceId;
    if (body.new_tab && body.to_workspace_id && body.to_workspace_id !== workspaceId) {
      const destWs = workspaces.getById(body.to_workspace_id);
      // Hidden workspaces are plumbing (a system container) — no user surface
      // lists them, so a tab parked there would simply disappear.
      if (!destWs || destWs.hidden)
        return c.json(
          { error: { code: 'not_found', message: 'destination workspace not found' } },
          404,
        );
      destWorkspaceId = destWs.id;
    }

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
    //
    // Landing in ANOTHER workspace is not churn, though: that's a genuine
    // relocation with a visible result, so a sole pane may still make the
    // trip.
    if (
      body.new_tab &&
      destWorkspaceId === workspaceId &&
      panes.listByTab(pane.tab_id).length <= 1
    ) {
      return c.json({
        pane: decorate(id),
        from_tab_id: sourceTab.id,
        to_tab: sourceTab,
        from_tab_removed: false,
      });
    }

    // Resolve the destination tab. On the `new_tab` path we only PREPARE the
    // seed here; the row itself is created inside the transaction below, so a
    // failure part-way through the move can't leave an orphan tab behind.
    let destTab: typeof sourceTab | null = null;
    let newTabSeed: { name: string; icon?: string } | null = null;
    const createdNewTab = body.new_tab === true;
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
      newTabSeed = {
        name: rest.trim() || randomWorkspaceName(),
        ...(leadingIcon ? { icon: leadingIcon } : {}),
      };
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
    if (destTab && destTab.id === sourceTab.id) {
      return c.json({
        pane: decorate(id),
        from_tab_id: sourceTab.id,
        to_tab: destTab,
        from_tab_removed: false,
      });
    }

    // ── ONE TRANSACTION FOR THE WHOLE MOVE ──────────────────────────────────
    // Reparenting the pane, repairing the destination layout and repairing (or
    // deleting) the source tab are three statements describing one change. Run
    // loose, a crash or a write failure between them leaves the source layout
    // pointing at a pane it no longer owns while the destination doesn't
    // mention it — a pane visible in no layout at all. The adjacent tab-merge
    // path already got this right; this now matches it.
    const sourceLayout = removeLeafFromLayout(sourceTab.layout, id);
    const sourceEmpty = sourceLayout === '' || sourceLayout == null;
    const seed = newTabSeed;
    const resolvedDest = destTab;
    // Exactly one of the two is set by construction above (new_tab ⇒ seed,
    // to_tab_id ⇒ resolvedDest); assert it rather than cast it away, so a
    // future edit to the resolution block fails loudly instead of creating a
    // nameless tab inside a transaction.
    if (!resolvedDest && !seed)
      return c.json({ error: { code: 'bad_request', message: 'no destination' } }, 400);
    const committed = deps.db.transaction(() => {
      const dest =
        resolvedDest ??
        tabs.create({
          ...(seed as { name: string; icon?: string }),
          layout: id,
          workspace_id: destWorkspaceId,
        });
      panes.setTab(id, dest.id);
      const finalDest = createdNewTab
        ? dest
        : tabs.update(dest.id, { layout: appendLeafToLayout(dest.layout, id) });
      let updatedSource: typeof sourceTab | null = null;
      if (sourceEmpty) {
        // The pane already moved out (its tab_id points at dest), so the
        // ON DELETE CASCADE won't touch it — only the now-empty source row goes.
        tabs.delete(sourceTab.id);
      } else {
        updatedSource = tabs.update(sourceTab.id, { layout: sourceLayout });
      }
      return { dest, finalDest, updatedSource };
    })();
    destTab = committed.dest;
    const finalDest = committed.finalDest;
    // Drop the activity pre-filter memo: the pane now belongs to a different
    // tab, and the next tick should bump the NEW one immediately rather than
    // sit out the remainder of the old tab's throttle window.
    deps.tabActivity?.forgetPane(id);

    // Emit destination events first so a client already viewing the dest tab
    // has the pane in its list before the layout referencing it lands.
    const decorated = decorate(id);
    if (createdNewTab) {
      // tab.added carries the full tab (layout already = the moved pane), so
      // the dest is fully described in one event; no separate pane.added.
      // The workspace id is the DESTINATION's — a client listening on another
      // workspace must not be told a tab appeared in its own.
      deps.events.emit({
        type: 'tab.added',
        workspace_id: destWorkspaceId,
        tab: decorateTab(deps.cache, deps.db, finalDest),
      });
    } else {
      if (decorated) deps.events.emit({ type: 'pane.added', tab_id: destTab.id, pane: decorated });
      deps.events.emit({ type: 'tab.updated', tab: decorateTab(deps.cache, deps.db, finalDest) });
    }

    // Then the source side.
    deps.events.emit({ type: 'pane.removed', tab_id: sourceTab.id, pane_id: id });
    if (sourceEmpty) {
      deps.tabActivity?.forget(sourceTab.id); // emptied source tab is gone
      deps.events.emit({ type: 'tab.removed', workspace_id: workspaceId, tab_id: sourceTab.id });
    } else if (committed.updatedSource) {
      deps.events.emit({
        type: 'tab.updated',
        tab: decorateTab(deps.cache, deps.db, committed.updatedSource),
      });
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
