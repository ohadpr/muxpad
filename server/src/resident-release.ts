// Graceful dismantling of the "resident pane" primitive (formerly the CEO
// pane, docs/plans/2026-08-21-ceo-pane.md §B).
//
// The primitive is GONE: nothing is ensured at boot, there is no /api/ceo, no
// pinned row, and no delete guards. A user who wants an always-there chat now
// creates one and PINS it — the living sidebar's pinned block does the job
// that the hardwired slot used to, and it's theirs to name, move and delete.
//
// But existing installs already have the artifact: a hidden system workspace
// holding a tab holding a real agent pane with real conversation history. With
// the pinned row removed, nothing in the UI would ever surface it again —
// hidden workspaces are filtered out of the sidebar — so it would become an
// invisible pane burning a runner forever, with history the user can't reach.
//
// So we RELEASE it rather than delete it: move its tabs into the first visible
// workspace, where they appear as ordinary tabs the user can keep, rename, pin
// or close. Their call, not ours — we never destroy a pane or a transcript.
//
// Runs ONCE, behind a `globals` marker: without that, a user who deliberately
// re-hid a workspace (or moved the tab back) would have it dragged out again
// on every boot.
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import { type PtydCache, decorateTab, decorateWorkspace } from './ptyd-cache.js';
import { randomWorkspaceName } from './random-name.js';
import { GlobalsStore } from './store/GlobalsStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';

/** The name the retired primitive gave its hidden container. */
const SYSTEM_WORKSPACE_NAME = '· system ·';

/** One-shot marker so the release can never run twice. */
const KEY_RELEASED = 'resident_pane_released';
/** Pointers the retired primitive wrote. Cleared as part of the release so
 *  they can't resolve to anything later. */
const LEGACY_KEYS = ['ceo_pane_id', 'ceo_tab_id', 'ceo_mode_defaulted'];

export interface ReleaseResult {
  /** False when there was nothing to do (fresh install, or already released). */
  released: boolean;
  /** Tabs moved out of the hidden container. */
  movedTabIds: string[];
  /** Set when the container itself was surfaced instead of emptied. */
  unhiddenWorkspaceId?: string;
}

/**
 * Move any tabs stranded in the retired system workspace somewhere the user
 * can see them, then retire the container. Idempotent and best-effort: a
 * failure here must never stop the server from booting.
 */
export function releaseResidentPane(deps: {
  db: Database.Database;
  events?: EventBus;
  /** Decorates the emitted rows with live status. Optional: the one-time
   *  release also runs in tests that have no cache, where an undecorated row
   *  is fine (nothing is running). */
  cache?: PtydCache;
}): ReleaseResult {
  const globals = new GlobalsStore(deps.db);
  const none: ReleaseResult = { released: false, movedTabIds: [] };
  if (globals.get(KEY_RELEASED)) return none;

  const workspaces = new WorkspaceStore(deps.db);
  const tabs = new TabStore(deps.db);
  const all = workspaces.list({ all: true });
  const system = all.find((w) => w.hidden && w.name === SYSTEM_WORKSPACE_NAME);

  // Nothing to release (fresh install, or the user already cleaned up). Still
  // set the marker so we stop looking on every boot.
  if (!system) {
    globals.set(KEY_RELEASED, '1');
    for (const k of LEGACY_KEYS) deps.db.prepare('DELETE FROM globals WHERE key = ?').run(k);
    return none;
  }

  const stranded = tabs.listByWorkspace(system.id);
  const destination = all.find((w) => !w.hidden);

  const result: ReleaseResult = { released: true, movedTabIds: [] };

  if (destination) {
    // The normal path: hand the tabs to a workspace the sidebar shows. Each
    // lands at the END of that workspace's order (setWorkspace appends), so
    // nothing the user already arranged gets displaced.
    for (const t of stranded) {
      tabs.setWorkspace(t.id, destination.id);
      // A tab that lived in the hidden container never had its activity
      // touched, so `last_activity_at` is NULL — and the living sidebar sorts
      // NULL to the very bottom. A rescued chat with real history would land
      // beneath every stale tab in the workspace, which is the opposite of
      // "here it is, we didn't lose it". Stamp NOW only when it has nothing:
      // a tab that DOES carry a real recency keeps it.
      if (t.last_activity_at == null) tabs.touchActivity(t.id);
      result.movedTabIds.push(t.id);
    }
    // The container has served its purpose. Deleting it is safe ONLY because
    // every tab moved out first — the rows now point at `destination`, so
    // they're outside the ON DELETE CASCADE's blast radius. Re-read to be
    // certain rather than trusting the loop above.
    if (tabs.listByWorkspace(system.id).length === 0) {
      workspaces.delete(system.id);
      deps.events?.emit({ type: 'workspace.removed', workspace_id: system.id });
    }
  } else {
    // Degenerate install: the hidden container is the ONLY workspace, so
    // there's nowhere to move to. Surface it in place instead of inventing a
    // workspace and shuffling rows — same outcome (the user can see and reach
    // their pane), fewer moving parts. It gets an ordinary generated name
    // because "· system ·" is plumbing the user should never have to read.
    deps.db
      .prepare('UPDATE workspaces SET hidden = 0, name = ?, updated_at = ? WHERE id = ?')
      .run(randomWorkspaceName(), Date.now(), system.id);
    result.unhiddenWorkspaceId = system.id;
  }

  globals.set(KEY_RELEASED, '1');
  for (const k of LEGACY_KEYS) deps.db.prepare('DELETE FROM globals WHERE key = ?').run(k);

  // Coarse events: the sidebar re-reads its workspace + tab lists off these,
  // which is exactly what has to happen for the released tabs to appear.
  const fresh = workspaces.getById(destination?.id ?? system.id);
  if (fresh)
    deps.events?.emit({
      type: 'workspace.updated',
      workspace: deps.cache ? decorateWorkspace(deps.cache, deps.db, fresh) : fresh,
    });
  for (const id of result.movedTabIds) {
    const t = tabs.getById(id);
    if (t && destination)
      deps.events?.emit({
        type: 'tab.added',
        workspace_id: destination.id,
        tab: deps.cache ? decorateTab(deps.cache, deps.db, t) : t,
      });
  }
  return result;
}
