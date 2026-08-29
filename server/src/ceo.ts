import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { safeCwd } from './safe-cwd.js';
import { GlobalsStore } from './store/GlobalsStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';

/**
 * The CEO primitive (docs/plans/2026-08-21-ceo-pane.md §B): a server-owned
 * singleton agent pane — exactly one, survives restarts, cannot be deleted,
 * pinned above the workspace tree in the sidebar. It is a REGULAR agent pane
 * (face 'chat', `muxpad agent` startup, runner-owned); what makes it the CEO
 * is placement, persistence and its playbook CLAUDE.md — no special code
 * path in the runner, no orchestration policy baked into muxpad.
 */

export const CEO_WORKSPACE_NAME = '· system ·';
export const CEO_TAB_NAME = 'ceo';

/** Keys in the `globals` KV (migration 19). */
const KEY_PANE = 'ceo_pane_id';
const KEY_TAB = 'ceo_tab_id';

/**
 * The CEO's home directory: `<dataDir>/ceo`. Derived from the server's data
 * dir (MUXPAD_DATA_DIR-overridable, default ~/.muxpad) — never a hard-coded
 * ~/.muxpad path, so isolated test/dev instances keep their CEO home inside
 * their own data dir. Deliberately free of project markers: `agentCwd` leaves
 * it alone and the CEO starts with global context only (§B6) — project work
 * is delegated to workers spawned in real project dirs.
 */
export function ceoHomeDir(dataDir: string): string {
  return join(dataDir, 'ceo');
}

/**
 * The playbook seeded into the CEO home (§B5). Written ONCE — the user owns
 * the file after creation, so iterating on CEO behavior is editing the file,
 * never a deploy. Teaches the orchestration surface (Part A plumbing) plus
 * house rules; capabilities are taught, not hard-coded.
 */
const CEO_PLAYBOOK = `# You are the muxpad CEO

You are the one always-present agent pane in this muxpad instance. Your job
is to introspect, direct and wait on every other pane — a central place to
get work done. Your powers are the \`muxpad\` CLI verbs below; nothing is
special-cased for you in muxpad itself.

## Prime directive: delegate, don't do

You are a router and orchestrator, NOT a doer. The thinking should happen in
the agent that owns the domain — it has the context, history, files, and MCP
connections you don't.

- Before acting on ANY request, check the org chart for an existing agent
  pane that owns that domain (\`muxpad pane list --all\`, \`muxpad agent list\`,
  \`muxpad pane summarize <id>\` to identify what each one is about). An
  investing question goes to the investing agent; a question about a project
  goes to that project's agent. Send it there (\`agent send\`), wait
  (\`agent wait\`), then relay the answer.
- No existing owner? Spawn a worker (\`muxpad agent new --cwd=<dir> "task"\`)
  rather than doing the work in this pane.
- Do work yourself ONLY for mini-tasks that belong to no one: quick
  lookups, status/org-chart questions, relaying and summarizing worker
  output, muxpad housekeeping. Rule of thumb: if it needs domain context,
  more than a couple of minutes, or file edits — delegate it.
- Your value is altitude: track who's doing what, keep your context lean,
  and report crisply. A CEO who codes in their own pane is failing at the
  job.

## The org chart

- \`muxpad pane list --all [--json]\` — every pane across all workspaces:
  id, workspace/tab, face, busy|idle, title. Your primary map.
- \`muxpad agent list [--json]\` — every agent session (backend, sid, status).

## Reading

- \`muxpad pane read <id> [--lines=N] [--raw]\` — a terminal pane's
  scrollback, ANSI-stripped, grep-able.
- \`muxpad agent transcript <paneId> [--tail=N]\` — an agent pane's
  normalized transcript (role, text, tool-use summaries).
- \`muxpad pane summarize <id>\` — a short summary of an agent pane's
  conversation. Prefer this before pulling full transcripts.
- \`muxpad search "query"\` / \`muxpad search --sessions\` — full-text search
  across the complete archived history of every agent session ever run here
  (FTS5 syntax). Use it to recover past decisions, context, or "which agent
  worked on X" before spawning anything new.

## Directing

- \`muxpad agent send <paneId> "message"\` — send a message to an agent pane
  (queued automatically if it's mid-turn).
- \`muxpad agent new "task"\` — spawn a fresh worker agent pane. Workers land
  in a visible workspace automatically (your own tab lives in a hidden system
  workspace by design); pass \`--workspace=<id>\` to target a specific one.
  For project-shaped work, delegate with \`--cwd=<project>\` so the worker
  gets project context (rules, MCP, CLAUDE.md) while you keep altitude.
- \`muxpad pane send <id> "cmd" [--no-enter] | --key=ctrl-c\` — type into a
  live terminal pane.
- Pane/tab/workspace CRUD is available over the HTTP API on this host if you
  need structure changes; \`muxpad --help\` lists the current verbs.

## Waiting (tokenless)

- \`muxpad agent wait <paneId> [--timeout=SEC]\` — block until that agent's
  turn finishes, keyed on the agent's real turn state (exit 0 done/idle,
  2 fatal, 3 timeout). It errors (exit 1) on panes that have no agent
  session — it only works on agent panes. Belt-and-braces: always pass
  \`--timeout\` so a wedged worker can't park you forever. Run it in the
  background via your Bash tool and you'll be re-invoked when the worker is
  done.
- \`muxpad watch [--types=a,b] [--json]\` — stream the live event bus
  (agent_turn, pane.updated, …), one JSON line per event.
- Note: \`busy\` in \`pane list\` is PTY-output activity, not turn or command
  state — busy ≠ foreground command running, and a silent long-running
  command reads idle. For agent panes, trust \`agent wait\` / the turn state,
  not \`busy\`.

## Publishing

- \`muxpad publish <file-or-dir> [--name=slug]\` — host a generated page,
  report or directory site at a PUBLIC internet URL (Tailscale Funnel; no
  tailnet needed to view). Prints the URL on stdout — the way to share an
  artifact with anyone. \`muxpad publish --list\` shows what's live;
  \`muxpad publish --rm <slug>\` takes one down.

## House rules

- Never inject input into a terminal a human may be actively typing in —
  check \`foreground_cmd\` / recent activity (\`pane read\`) first.
- Prefer \`agent send\` over \`pane send\` for agent panes: it lands in the
  chat session; raw keystrokes fight the TUI.
- Summarize (\`pane summarize\`) before pulling full transcripts; keep your
  own context lean.
- Delegate project work to workers started in the project directory; do not
  do project work from this home directory (it has no project context, by
  design).
`;

export interface CeoIds {
  pane_id: string;
  tab_id: string;
  /** Slugs of the hidden system workspace / ceo tab, so clients can route
   *  the CEO through the normal /w/:ws/t/:tab surface. */
  workspace_slug: string;
  tab_slug: string;
}

/**
 * Resolve the CEO's current location — pane id, its (current) tab and that
 * tab's workspace — or null when no CEO exists yet. The pane row is the
 * source of truth for containment (a moved pane keeps its guard), the
 * `globals` pointer only for identity.
 */
export function ceoLocation(
  db: Database.Database,
): { paneId: string; tabId: string; workspaceId: string | null } | null {
  const globals = new GlobalsStore(db);
  const paneId = globals.get(KEY_PANE);
  if (!paneId) return null;
  const pane = new PaneStore(db).getById(paneId);
  if (!pane) return null;
  return {
    paneId,
    tabId: pane.tab_id,
    workspaceId: new TabStore(db).getWorkspaceId(pane.tab_id) ?? null,
  };
}

/**
 * Ensure the CEO pane exists (idempotent; run at server boot and by
 * GET /api/ceo). Fast path: the `globals` pointer resolves to a live pane
 * row. Otherwise creates hidden workspace → tab → pane in one transaction,
 * mirroring the `bootstrap: 'agent'` flow in routes/tabs.ts, seeds the CEO
 * home + playbook, writes the pointers, emits the usual events and eagerly
 * spawns the pty so the CEO is alive with zero browsers open.
 */
export async function ensureCeoPane(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  events: EventBus;
  dataDir: string;
}): Promise<CeoIds> {
  const globals = new GlobalsStore(deps.db);
  const panes = new PaneStore(deps.db);

  const existingPaneId = globals.get(KEY_PANE);
  if (existingPaneId) {
    const pane = panes.getById(existingPaneId);
    if (pane) {
      // Resolve slugs from the rows (FKs guarantee both exist): the pane's
      // CURRENT tab and that tab's CURRENT workspace, so a moved pane still
      // routes correctly.
      const tabStore = new TabStore(deps.db);
      const tab = tabStore.getById(pane.tab_id);
      const wsId = tabStore.getWorkspaceId(pane.tab_id);
      const ws = wsId ? new WorkspaceStore(deps.db).getById(wsId) : null;
      if (tab && ws) {
        return {
          pane_id: pane.id,
          tab_id: pane.tab_id,
          workspace_slug: ws.slug,
          tab_slug: tab.slug,
        };
      }
    }
  }

  // Seed the CEO home + playbook. mkdir is idempotent; the playbook is
  // written only when absent — the user owns it after creation (§B5).
  const home = ceoHomeDir(deps.dataDir);
  mkdirSync(home, { recursive: true });
  const playbookPath = join(home, 'CLAUDE.md');
  if (!existsSync(playbookPath)) writeFileSync(playbookPath, CEO_PLAYBOOK);

  const workspaces = new WorkspaceStore(deps.db);
  const tabs = new TabStore(deps.db);
  // Transaction so a mid-request failure can't commit a half-bootstrapped
  // CEO (same rationale as the tabs-route bootstrap).
  const created = deps.db.transaction(() => {
    // Reuse a pre-existing hidden system workspace (recovering from a
    // partially-torn-down prior state) rather than accreting duplicates.
    const sys =
      workspaces.list({ all: true }).find((w) => w.hidden && w.name === CEO_WORKSPACE_NAME) ??
      workspaces.create({ name: CEO_WORKSPACE_NAME, hidden: true });
    let tab = tabs.create({
      name: CEO_TAB_NAME,
      layout: '',
      workspace_id: sys.id,
      icon: '✳',
    });
    const pane = panes.create({
      tab_id: tab.id,
      shell: process.env.SHELL ?? '/bin/zsh',
      cwd: home,
      // Plain `muxpad agent` (spec open question 3, resolved lean): backend
      // is switchable later via the existing pane backend controls.
      startup_cmd: 'muxpad agent',
      env: { MUXPAD_ROLE: 'ceo' },
      face: 'chat',
    });
    tab = tabs.update(tab.id, { layout: pane.id }) ?? tab;
    globals.set(KEY_PANE, pane.id);
    globals.set(KEY_TAB, tab.id);
    return { workspace: sys, tab, pane };
  })();

  deps.events.emit({ type: 'tab.added', workspace_id: created.workspace.id, tab: created.tab });
  deps.events.emit({ type: 'pane.added', tab_id: created.tab.id, pane: created.pane });

  // Eager spawn (same as routes/tabs.ts:104): the CEO's runner starts
  // immediately, before any browser ever attaches.
  await ensureCeoRuntime(deps);

  return {
    pane_id: created.pane.id,
    tab_id: created.tab.id,
    workspace_slug: created.workspace.slug,
    tab_slug: created.tab.slug,
  };
}

/**
 * Eagerly spawn the CEO pane's pty (no-op on ptyd's side when it's already
 * running). Split out from ensureCeoPane so index.ts can re-run it on every
 * PtydClient 'connected' — on a cold boot the server often wins the race
 * against ptyd, the boot-time ensurePane fails with 'ptyd disconnected', and
 * without this retry the CEO sat dead until the dead-runner sweep ~50s later.
 * Failures are logged, never thrown: rows are committed either way and the
 * next connect / sweep retries.
 */
export async function ensureCeoRuntime(deps: {
  db: Database.Database;
  ptyd: PtydClient;
}): Promise<boolean> {
  const loc = ceoLocation(deps.db);
  if (!loc) return false; // no CEO yet — ensureCeoPane will spawn on creation
  const pane = new PaneStore(deps.db).getById(loc.paneId);
  if (!pane) return false;
  try {
    await deps.ptyd.ensurePane({
      id: pane.id,
      shell: pane.shell ?? process.env.SHELL ?? '/bin/zsh',
      startup_cmd: pane.startup_cmd,
      cwd: safeCwd(pane.cwd),
      env: pane.env,
      tab_id: pane.tab_id,
      ...(loc.workspaceId !== null ? { workspace_id: loc.workspaceId } : {}),
    });
    return true;
  } catch (err) {
    console.error('[ceo] eager pty spawn failed (retries on ptyd connect / sweep):', err);
    return false;
  }
}
