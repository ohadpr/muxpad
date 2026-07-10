import type Database from 'better-sqlite3';
import type { PtydClient } from './ptyd-client/PtydClient.js';

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
export function queuePaneKill(db: Database.Database, paneId: string): void {
  try {
    db.prepare('INSERT OR REPLACE INTO pending_pane_kills (pane_id, created_at) VALUES (?, ?)').run(
      paneId,
      Date.now(),
    );
  } catch (e) {
    console.error('[reaper] failed to queue pane kill', paneId, e);
  }
}

export function startPaneReaper(deps: {
  db: Database.Database;
  ptyd: PtydClient;
  /** Returns true when the pane id has a DB row (reconcile keeps those). */
  paneExists: (id: string) => boolean;
  sweepMs?: number;
}): void {
  const { db, ptyd, paneExists } = deps;

  const sweepQueue = async () => {
    const rows = db.prepare('SELECT pane_id FROM pending_pane_kills').all() as {
      pane_id: string;
    }[];
    for (const r of rows) {
      try {
        await ptyd.killPane(r.pane_id);
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
