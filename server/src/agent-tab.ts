// Creating and destroying a bootstrapped tab, as ONE function each.
//
// Both operations were previously inlined in routes/tabs.ts. The cron
// scheduler's new-tab mode needs exactly the same thing (rows + layout +
// events + eager ptyd spawn; then the reverse), and a second hand-written copy
// of "how you make an agent tab" is how the two would drift on the next change
// to the startup-command shape. The route now calls these; nothing about its
// behaviour changed.
import type { AgentMode, LayoutNode, PaneSpec, Tab } from '@muxpad/shared';
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
  /** Tab name. Omit for the bootstrap defaults ('agent' / a random name). */
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
  const modePart = opts.mode === 'do' ? ' --mode do' : '';
  // Single-quoted model so zsh's nomatch can't glob-error on ids with brackets
  // ('claude-opus-4-8[1m]'); the charset gate upstream makes the quoting safe.
  const modelPart = opts.model ? ` --model '${opts.model}'` : '';
  return `muxpad agent${backendPart}${modePart}${modelPart}`;
}

/**
 * Create a tab (optionally with its bootstrapped pane), emit the events, and
 * eagerly spawn the pty. Rows commit in one transaction so a mid-request
 * failure can't leave a half-bootstrapped ghost tab.
 */
export async function bootstrapTab(
  deps: BootstrapTabDeps,
  input: BootstrapTabInput,
): Promise<{ tab: Tab; pane: PaneSpec | null }> {
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);
  const agent = input.bootstrap === 'agent';
  const created = deps.db.transaction(() => {
    let tab = tabs.create({
      name: input.name as string,
      layout: input.layout ?? '',
      workspace_id: input.workspace_id,
      ...(input.icon ? { icon: input.icon } : {}),
    });
    if (!input.bootstrap) return { tab, pane: null as PaneSpec | null };
    const pane = panes.create({
      tab_id: tab.id,
      shell: process.env.SHELL ?? '/bin/zsh',
      // Agent panes snap up to the git root so they start with project context.
      cwd: agent ? agentCwd(safeCwd(input.cwd)) : safeCwd(input.cwd),
      startup_cmd: agent
        ? agentStartupCmd({ backend: input.backend, mode: input.mode, model: input.model })
        : null,
      // Agent tabs land directly on the chat face; the (hidden) terminal face
      // spawns the pty underneath, which runs the startup command.
      face: agent ? 'chat' : 'terminal',
      ...(agent && input.mode ? { mode: input.mode } : {}),
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
      pane: decoratePane(deps.cache, created.pane),
    });
    // Eager spawn: an agent tab created from a phone (or by the cron tick,
    // with no browser anywhere) starts its runner immediately.
    try {
      await deps.ptyd.ensurePane({
        id: created.pane.id,
        shell: created.pane.shell ?? process.env.SHELL ?? '/bin/zsh',
        startup_cmd: created.pane.startup_cmd,
        cwd: safeCwd(created.pane.cwd),
        env: created.pane.env,
        tab_id: created.tab.id,
        workspace_id: input.workspace_id,
      });
    } catch {
      // ptyd unreachable: the rows are committed; the runtime spawns lazily
      // when a client attaches and ptyd reconnects.
    }
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
