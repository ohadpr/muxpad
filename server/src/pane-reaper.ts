import type Database from 'better-sqlite3';
import type { PaneOps } from './node-link/PaneRouter.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { LOCAL_NODE_ID, NodeStore } from './store/NodeStore.js';

/**
 * Straggler prevention for pane processes. Two layers:
 *
 * 1. Durable kill queue — a pane DELETE whose ptyd kill fails in transit
 *    (socket hiccup, ptyd briefly unreachable) proceeds with the DB cascade,
 *    which would otherwise leave the pty running forever with no row and no
 *    UI that could ever reach it. Routes call {@link queuePaneKill} on kill
 *    failure; the sweeper retries until ptyd confirms (killPane on an
 *    unknown id is an idempotent no-op, so over-sweeping is safe).
 *
 * 2. Reconcile — on ptyd (re)connect, ask ptyd for its live pane ids and
 *    kill any with no DB row (catches divergence with an unknown cause, not
 *    just recorded failures). Needs the listPanes RPC; a ptyd predating it
 *    makes the call throw, which is swallowed — the layer activates on the
 *    next ptyd restart.
 */
/**
 * Record that this pane's process must still be killed.
 *
 * The NODE IS RESOLVED HERE, while the row still exists. Callers queue a kill
 * precisely when the row is about to go (or has just gone) in a cascade, so
 * resolving it later is too late: an unknown pane reads as `local`, the retry
 * goes to the mac, ptyd answers "unknown id" as a success, the tombstone is
 * cleared, and the real process on the other machine is orphaned forever.
 *
 * `nodeId` may be passed by a caller that already knows it (a cascade that
 * read the row before deleting). Otherwise it is looked up, which works for
 * every caller that queues BEFORE the delete.
 */
export function queuePaneKill(db: Database.Database, paneId: string, nodeId?: string): void {
  try {
    const node = nodeId ?? new NodeStore(db).nodeForPane(paneId);
    db.prepare(
      'INSERT OR REPLACE INTO pending_pane_kills (pane_id, created_at, node_id) VALUES (?, ?, ?)',
    ).run(paneId, Date.now(), node);
  } catch (e) {
    console.error('[reaper] failed to queue pane kill', paneId, e);
  }
}

export function startPaneReaper(deps: {
  db: Database.Database;
  ptyd: PaneOps;
  /** Returns true when the pane id has a DB row (reconcile keeps those). */
  paneExists: (id: string) => boolean;
  sweepMs?: number;
}): void {
  const { db, ptyd, paneExists } = deps;

  const sweepQueue = async () => {
    const rows = db.prepare('SELECT pane_id, node_id FROM pending_pane_kills').all() as {
      pane_id: string;
      node_id: string | null;
    }[];
    for (const r of rows) {
      try {
        // Targeted at the node recorded when the kill was queued. A router
        // THROWS for an unreachable node, which lands in the catch below and
        // KEEPS the tombstone — the one behaviour that matters here, since
        // the process is still out there.
        await killOn(ptyd, r.node_id ?? LOCAL_NODE_ID, r.pane_id);
        db.prepare('DELETE FROM pending_pane_kills WHERE pane_id = ?').run(r.pane_id);
        console.log(`[reaper] straggler pane ${r.pane_id} killed (queued kill retried)`);
      } catch {
        // ptyd still unreachable — keep the row; next sweep retries.
      }
    }
  };

  const reconcile = async () => {
    let live: string[];
    try {
      live = await ptyd.listPanes();
    } catch {
      return; // pre-listPanes ptyd — layer activates after its next restart
    }
    for (const id of live) {
      if (paneExists(id)) continue;
      try {
        await ptyd.killPane(id);
        console.log(`[reaper] orphan pane ${id} killed (live in ptyd, no DB row)`);
      } catch {
        queuePaneKill(db, id);
      }
    }
  };

  // On every ptyd (re)connect: retry queued kills, then reconcile.
  ptyd.on('connected', () => {
    void sweepQueue().then(reconcile);
  });
  // Slow steady sweep as the fallback heartbeat.
  setInterval(() => void sweepQueue(), deps.sweepMs ?? 60_000).unref?.();
  // And once at boot (the 'connected' event may have fired before we
  // subscribed, depending on construction order).
  void sweepQueue().then(reconcile);
}

/**
 * Kill `id` on `nodeId`, using the node-aware path when one is available.
 *
 * A plain PtydClient has no notion of nodes, so for it the only honest
 * behaviour is: do the local kill when the tombstone says local, and REFUSE
 * when it names another machine. Refusing keeps the tombstone, which is far
 * better than sending the kill somewhere it would be reported as a success.
 */
async function killOn(ptyd: PaneOps, nodeId: string, id: string): Promise<void> {
  const router = ptyd as PaneOps & { killPaneOn?: (n: string, i: string) => Promise<void> };
  if (typeof router.killPaneOn === 'function') return router.killPaneOn(nodeId, id);
  if (nodeId !== LOCAL_NODE_ID)
    throw new Error(`cannot kill pane ${id} on node ${nodeId}: no node-aware transport`);
  return ptyd.killPane(id);
}
