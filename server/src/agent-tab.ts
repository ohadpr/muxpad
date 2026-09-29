// Creating and destroying a bootstrapped tab, as ONE function each.
//
// Both operations were previously inlined in routes/tabs.ts. The cron
// scheduler's new-tab mode needs exactly the same thing (rows + layout +
// events + eager ptyd spawn; then the reverse), and a second hand-written copy
// of "how you make an agent tab" is how the two would drift on the next change
// to the startup-command shape. The route now calls these; nothing about its
// behaviour changed.
import {
  type AgentMode,
  type LayoutNode,
  type PaneSpec,
  type Tab,
  modeForBackend,
} from '@muxpad/shared';
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import { queuePaneKill } from './pane-reaper.js';
import { agentCwd } from './project-root.js';
import { type PtydCache, decoratePane, decorateTab } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { safeCwd } from './safe-cwd.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import type { TabActivity } from './tab-activity.js';

export interface BootstrapTabDeps {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
}

export interface BootstrapTabInput {
  workspace_id: string;
  /** Tab name. Omit for the bootstrap defaults (BOOTSTRAP_TAB_NAME / a random name). */
  name?: string | undefined;
  layout?: LayoutNode | undefined;
  bootstrap?: 'shell' | 'agent' | undefined;
  cwd?: string | undefined;
  /** Validated upstream against /^[A-Za-z0-9._[\]-]{1,64}$/ — it is baked into
   *  a shell command. */
  model?: string | undefined;
  backend?: 'claude' | 'codex' | 'cursor' | 'pick' | undefined;
  mode?: AgentMode | undefined;
  icon?: string | undefined;
  /** The chat this one is being spawned FROM. Shares that chat's decay clock
   *  and nests under it in the sidebar. Resolved (and dropped if the parent is
   *  gone) by the caller — see routes/tabs.ts. */
  spawned_by?: string | undefined;
}

/**
 * The startup command for an agent pane. ONE builder, because the exact flag
 * ORDER is load-bearing: ws.ts's self-heal rewrite composes the same shape and
 * compares it to the stored command to tell a reconnect from a new runner, so
 * a different order re-flips the pane's face on every hello.
 */
export function agentStartupCmd(opts: {
  backend?: 'claude' | 'codex' | 'cursor' | 'pick' | undefined;
  mode?: AgentMode | undefined;
  model?: string | undefined;
}): string {
  // A PENDING pane keeps the exact literal `muxpad agent --pick`: several call
  // sites (the harness-choice routes' 409 gate, the dead-runner sweep's skip)
  // compare against it verbatim.
  if (opts.backend === 'pick') return 'muxpad agent --pick';
  const backendPart = opts.backend && opts.backend !== 'claude' ? ` --backend ${opts.backend}` : '';
  // Agent mode is the ABSENCE of the flag (agent-modes.ts), which is what
  // keeps every pre-rename bare `muxpad agent` command meaning exactly what it
  // always meant.
  const modePart = opts.mode === 'chat' ? ' --mode chat' : '';
  // Single-quoted model so zsh's nomatch can't glob-error on ids with brackets
  // ('claude-opus-4-8[1m]'); the charset gate upstream makes the quoting safe.
  const modelPart = opts.model ? ` --model '${opts.model}'` : '';
  return `muxpad agent${backendPart}${modePart}${modelPart}`;
}

/**
 * How long a create request will wait for ptyd to acknowledge the eager spawn
 * before answering anyway.
 *
 * WHY THERE IS A CAP AT ALL. ptyd's `ensurePane` RPC is nominally
 * fire-and-forget — its handler calls `getOrCreate` and replies immediately —
 * but `getOrCreate` ends in a SYNCHRONOUS `PaneRuntime.start()`, and the reply
 * is written after it returns. So the acknowledgement is gated on a real pty
 * fork on ptyd's single event loop, behind whatever else that loop is already
 * doing for every other live pane. Measured on this machine, `POST /api/tabs`
 * with an agent bootstrap: 0.03s idle, and 19.5s and 38.6s while ptyd was busy
 * spawning. The same request with no bootstrap — rows only, no ptyd call — is
 * 4–90ms throughout, which is where the seconds were.
 *
 * That wait bought the caller nothing. The result is discarded, the failure
 * path is a swallowed catch, and the runtime is recoverable either way (a
 * client attach re-ensures; ChatNoRunner offers "Start agent"). It was pure
 * latency, and it was latency the WEB SIDEBAR sat in: the create button could
 * not navigate until this resolved.
 *
 * WHY NOT ZERO. The common case is genuinely fast, and answering after it
 * leaves the old guarantee intact — the pty exists by the time the client
 * lands — which is what keeps ChatPane's 8s no-session grace measured against
 * a live pty rather than against a queue. 250ms covers the idle case several
 * times over and truncates the pathological one; it is a ceiling, not a delay,
 * so an idle ptyd still returns in its own 30ms.
 *
 * NOT FIXABLE FROM HERE. The blocking spawn is ptyd's, and ptyd only picks up
 * changes on a restart that kills every pane on the machine. This caps our
 * exposure to it; it does not make ptyd faster.
 */
const EAGER_SPAWN_WAIT_MS = 250;

/**
 * Eager spawns that have been ASKED FOR but not yet acknowledged, by pane id.
 *
 * The cap above means `bootstrapTab` can answer before the pty exists, which
 * opens a race the blocking await used to close by accident: **a pane can be
 * deleted before its own spawn has landed.** `killPane` on a pane ptyd has not
 * created yet is a successful no-op, so the delete completes, the queued spawn
 * then arrives, and ptyd is left holding a pty whose DB row is gone — invisible
 * to every UI and unreachable by anything except the straggler reconcile, which
 * only runs on a ptyd reconnect (i.e. a restart that kills every pane).
 *
 * The kill queue cannot cover this either: the sweeper dequeues as soon as
 * `killPane` *succeeds*, and against a not-yet-spawned pane it succeeds
 * immediately, doing nothing.
 *
 * This was observed, not theorised — a batch of agent tabs deleted while ptyd
 * was saturated left eight orphaned runners alive with no rows behind them.
 * So a delete BOOKS A SECOND KILL against any pane whose spawn is still in
 * flight, to run the moment that spawn lands.
 *
 * A chaser rather than an await, and the distinction is the whole design: the
 * delete must not inherit the unbounded wait this file exists to remove, and a
 * ptyd that never answers would hang the cascade instead of merely leaking a
 * pty — strictly worse than the bug. The delete therefore stays exactly as
 * fast as it was, and the chaser cleans up behind it.
 */
const inFlightSpawns = new Map<string, Promise<void>>();

/**
 * Create a tab (optionally with its bootstrapped pane), emit the events, and
 * eagerly spawn the pty. Rows commit in one transaction so a mid-request
 * failure can't leave a half-bootstrapped ghost tab.
 *
 * Resolves once the rows are committed and the events are out — NOT
 * necessarily once the pty is up. See EAGER_SPAWN_WAIT_MS.
 */
export async function bootstrapTab(
  deps: BootstrapTabDeps,
  input: BootstrapTabInput,
): Promise<{ tab: Tab; pane: PaneSpec | null }> {
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);
  const agent = input.bootstrap === 'agent';
  // An agent bootstrap that doesn't name a mode gets the DEFAULT — Chat.
  // This is the one place the flipped default actually lands: the CLI
  // (`muxpad agent new`), the API, the cron scheduler's new-tab fire and the
  // web app all bootstrap through here, so "a new agent tab is a Chat" holds
  // no matter which door it came in. A non-agent bootstrap stays on the
  // baseline (PaneStore.create) — there is no agent in it to contract with.
  //
  // …except that Chat mode is CLAUDE-ONLY (modeForBackend): a codex/cursor
  // bootstrap lands in Agent mode whatever the caller asked for, because
  // neither harness can host the `reply` tool Chat mode is built on.
  const mode: AgentMode | undefined = agent ? modeForBackend(input.mode, input.backend) : undefined;
  const created = deps.db.transaction(() => {
    let tab = tabs.create({
      name: input.name as string,
      layout: input.layout ?? '',
      workspace_id: input.workspace_id,
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.spawned_by ? { spawned_by: input.spawned_by } : {}),
    });
    if (!input.bootstrap) return { tab, pane: null as PaneSpec | null };
    const pane = panes.create({
      tab_id: tab.id,
      shell: process.env.SHELL ?? '/bin/zsh',
      // Agent panes snap up to the git root so they start with project context.
      cwd: agent ? agentCwd(safeCwd(input.cwd)) : safeCwd(input.cwd),
      startup_cmd: agent
        ? agentStartupCmd({ backend: input.backend, mode, model: input.model })
        : null,
      // Agent tabs land directly on the chat face; the (hidden) terminal face
      // spawns the pty underneath, which runs the startup command.
      face: agent ? 'chat' : 'terminal',
      ...(mode ? { mode } : {}),
    });
    tab = tabs.update(tab.id, { layout: pane.id }) ?? tab;
    return { tab, pane };
  })();
  deps.events.emit({
    type: 'tab.added',
    workspace_id: input.workspace_id,
    tab: decorateTab(deps.cache, deps.db, created.tab),
  });
  if (created.pane) {
    // Through decoratePane like every other pane payload — a raw row's absent
    // status/agents fields blank the new pane's status rail until the next poll.
    deps.events.emit({
      type: 'pane.added',
      tab_id: created.tab.id,
      pane: decoratePane(deps.cache, created.pane, deps.db),
    });
    // Eager spawn: an agent tab created from a phone (or by the cron tick,
    // with no browser anywhere) starts its runner immediately.
    //
    // STARTED eagerly, WAITED FOR only briefly — see EAGER_SPAWN_WAIT_MS. The
    // spawn keeps running past the cap; we simply stop holding the response
    // hostage to it.
    const spawning = deps.ptyd
      .ensurePane({
        id: created.pane.id,
        shell: created.pane.shell ?? process.env.SHELL ?? '/bin/zsh',
        startup_cmd: created.pane.startup_cmd,
        cwd: safeCwd(created.pane.cwd),
        env: created.pane.env,
        tab_id: created.tab.id,
        workspace_id: input.workspace_id,
      })
      .catch(() => {
        // ptyd unreachable: the rows are committed; the runtime spawns lazily
        // when a client attaches and ptyd reconnects. Caught HERE rather than
        // by the caller because nobody is necessarily awaiting this any more,
        // and an unhandled rejection would take the server down.
      });
    // Published for deleteTabCascade — see inFlightSpawns. Cleared on settle,
    // so a pane that is never deleted leaves nothing behind.
    const paneId = created.pane.id;
    inFlightSpawns.set(paneId, spawning);
    void spawning.finally(() => {
      // Only if we are still the spawn of record: a respawn/recreate for the
      // same id must not have its entry dropped by an older settle.
      if (inFlightSpawns.get(paneId) === spawning) inFlightSpawns.delete(paneId);
    });
    let cap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      spawning,
      new Promise<void>((resolve) => {
        cap = setTimeout(resolve, EAGER_SPAWN_WAIT_MS);
      }),
    ]);
    clearTimeout(cap);
  }
  return created;
}

/**
 * Delete a tab, its panes' ptys, and their rows; emit `tab.removed`. ptyd
 * holds runtime state, SQLite is the source of truth — if ptyd is unreachable
 * the DB cascade must still proceed, so a kill lost in transit is queued for
 * the reaper rather than abandoning the delete (which would leave a pty
 * running forever with no row and no UI that could reach it).
 */
export async function deleteTabCascade(
  deps: BootstrapTabDeps & { tabActivity?: TabActivity | undefined },
  tabId: string,
): Promise<boolean> {
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);
  if (!tabs.getById(tabId)) return false;
  const workspaceId = tabs.getWorkspaceId(tabId);
  const doomed = panes.listByTab(tabId);
  for (const p of doomed) {
    // A pane whose own eager spawn has not landed yet gets a SECOND kill,
    // booked for the moment it does — see inFlightSpawns. Deliberately not an
    // `await`: the delete must not inherit the unbounded wait this file exists
    // to remove, and awaiting a ptyd that never answers would hang the cascade
    // outright (it hung a test teardown when written that way). So the kill
    // below still runs now, at its normal speed, and this only adds a chaser
    // for the one case where "now" was too early to catch anything.
    const spawning = inFlightSpawns.get(p.id);
    if (spawning) {
      void spawning.then(() => deps.ptyd.killPane(p.id).catch(() => queuePaneKill(deps.db, p.id)));
    }
    try {
      await deps.ptyd.killPane(p.id);
    } catch {
      queuePaneKill(deps.db, p.id);
    }
  }
  // Rows FIRST (the cascade), caches second: `cache.forget` fires
  // 'paneRemoved', whose subscriber emits a `pane.updated` for any pane whose
  // row still exists — forgetting first announced one update per pane of a tab
  // that was about to vanish. Clients infer the pane removals from tab.removed.
  tabs.delete(tabId);
  for (const p of doomed) {
    deps.cache.forget(p.id);
    deps.tabActivity?.forgetPane(p.id);
  }
  deps.tabActivity?.forget(tabId);
  if (workspaceId) {
    deps.events.emit({ type: 'tab.removed', workspace_id: workspaceId, tab_id: tabId });
  }
  return true;
}
