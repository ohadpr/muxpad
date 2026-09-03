import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { type CatalogModel, readModelCatalog } from '../agent-model-catalog.js';
import { agentCwd, hasProjectContext } from '../project-root.js';

/** How many recent folders the launch picker offers as one-tap chips. Enough
 *  to cover "the handful of things I'm actually working on"; short enough that
 *  the strip stays one glanceable row on a phone. */
const MAX_FOLDERS = 6;

export interface RecentFolder {
  /** Absolute path, already snapped to its project root. */
  path: string;
  /** Last path segment — the chip's label. */
  name: string;
  /** `~`-relative form for the chip's title/secondary line. */
  short: string;
  /** Does an agent get rules/MCP/repo here? Drives the picker's quiet warning. */
  hasProject: boolean;
}

/** `/Users/me/dev/x` → `~/dev/x`. Display only — never fed back to a spawn. */
export function tildePath(p: string, home: string = homedir()): string {
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * Folders the user has recently run something in, most recent first.
 *
 * Two sources, because neither alone is the answer:
 *  - `session_history` is the append-only record of every agent session and its
 *    cwd. This is the good signal — "places I have actually worked" — and it
 *    survives the pane being deleted.
 *  - `panes` covers the rest: a folder opened as a terminal, or an agent pane
 *    created so recently that no session id has been recorded yet.
 *
 * Deduped by path, keeping the newest timestamp, then filtered to directories
 * that still EXIST — a worktree torn down last week must not be offered as a
 * one-tap option that spawns into home instead (safeCwd's fallback) and quietly
 * lies about where the session started.
 *
 * Exported for tests; the route is a thin wrapper.
 */
export function recentFolders(db: Database.Database, limit = MAX_FOLDERS): RecentFolder[] {
  const seen = new Map<string, number>();
  const add = (rows: Array<{ cwd: string | null; at: number | null }>) => {
    for (const r of rows) {
      if (!r.cwd) continue;
      const at = r.at ?? 0;
      const prev = seen.get(r.cwd);
      if (prev === undefined || at > prev) seen.set(r.cwd, at);
    }
  };
  // Both queries are best-effort: a database predating either table (or an
  // instance where a migration is mid-flight) must degrade to "no suggestions",
  // never to a 500 on the picker.
  try {
    add(
      db
        .prepare(
          'SELECT cwd, MAX(last_seen) AS at FROM session_history WHERE cwd IS NOT NULL GROUP BY cwd',
        )
        .all() as Array<{ cwd: string | null; at: number | null }>,
    );
  } catch {
    // no session_history — fall through to panes
  }
  try {
    add(
      db
        .prepare(
          "SELECT cwd, MAX(created_at) AS at FROM panes WHERE cwd IS NOT NULL AND kind = 'shell' GROUP BY cwd",
        )
        .all() as Array<{ cwd: string | null; at: number | null }>,
    );
  } catch {
    // no panes table — impossible in practice, cheap to survive
  }
  const home = homedir();
  const out: RecentFolder[] = [];
  const emitted = new Set<string>();
  for (const [raw, _at] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    // Snap to the project root, exactly as a new agent pane would — otherwise
    // the chip advertises `…/src/components` and the session starts two levels
    // up, which reads as the picker ignoring the tap.
    let path: string;
    try {
      if (!statSync(raw).isDirectory()) continue;
      // realpath BEFORE snapping: one folder reachable by two names is one
      // folder. Without it macOS hands back both `/var/…` (the stored spawn
      // cwd) and `/private/var/…` (what the live shell reports), and the
      // picker draws the same directory as two chips.
      path = agentCwd(realpathSync(raw));
    } catch {
      continue; // vanished (torn-down worktree, unmounted volume, renamed dir)
    }
    if (emitted.has(path)) continue;
    emitted.add(path);
    out.push({
      path,
      name: path.split('/').filter(Boolean).pop() ?? path,
      short: tildePath(path, home),
      hasProject: hasProjectContext(path),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Everything the "start a harness here" picker needs, in ONE request.
 *
 * The picker opens on a tap and must be complete on the next frame — a chip row
 * that pops in after two separate round trips is a layout jump under the user's
 * thumb. Models and folders are both cheap reads (a `globals` row and two
 * grouped selects), so they travel together.
 */
export function agentLaunchRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();

  app.get('/options', (c) => {
    const catalog = readModelCatalog(deps.db);
    const models: Record<string, CatalogModel[]> = {};
    for (const b of ['claude', 'codex', 'cursor']) {
      const list = catalog[b];
      if (list && list.length > 0) models[b] = list;
    }
    return c.json({ folders: recentFolders(deps.db), models, home: homedir() });
  });

  return app;
}
