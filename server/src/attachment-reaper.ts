import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

/**
 * The files nobody can reach, and the two ways they are made.
 *
 * `attachments.pane_id` is `ON DELETE CASCADE`, so deleting a pane — or a tab,
 * or a workspace, both of which cascade into panes — removes the attachment
 * ROWS. Nothing has ever removed the FILES. Measured on a real install: 1493
 * files against 794 rows, so 699 files and 348 MB that no query reaches and no
 * sweep collected, growing with every chat deleted.
 *
 * Mirrors `pane-reaper`, deliberately, because it is the same problem wearing a
 * different resource: a row is gone and an OS object outlived it.
 *
 *   1. Durable unlink queue — a trigger (migration 37) records every deleted
 *      row's path. A trigger rather than a call in each delete path because the
 *      cascade is SQLite's and the application never sees it: `DELETE FROM
 *      tabs` reaches panes without passing through PaneStore.delete, and a
 *      workspace reaches them through two cascades. The row is where every
 *      path converges. The sweeper does the unlink, because a trigger cannot
 *      touch the filesystem and the DELETE has to commit either way.
 *
 *   2. Reconcile — walk the directory and remove files with no row at all.
 *      Catches divergence with an unknown cause, which is what the 699 are:
 *      they predate the trigger, so no queue entry will ever name them.
 */

/**
 * How old an unreferenced file must be before reconcile will take it.
 *
 * NOT a tidiness knob — it closes a race that would otherwise delete a live
 * upload. The routes write the file and THEN insert the row (attachments.ts),
 * so between those two statements a perfectly good attachment has no row and
 * looks exactly like an orphan. An hour is far longer than that window and far
 * shorter than the lifetime of real debris.
 */
const RECONCILE_MIN_AGE_MS = 60 * 60 * 1000;

export interface AttachmentSweepResult {
  /** Queue entries drained — files whose row was deleted. */
  unlinked: number;
  /** Files removed by reconcile — no row, older than the grace period. */
  reconciled: number;
  /** Bytes freed across both. */
  bytes: number;
  /** Queue entries kept for the next pass (the unlink failed, and not because
   *  the file was already gone). */
  retained: number;
}

/** Remove one file, reporting its size. Missing is SUCCESS: the goal is that
 *  the file not be there, and something else having got to it first satisfies
 *  that completely. */
function removeFile(path: string): { ok: boolean; bytes: number; gone: boolean } {
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    return { ok: true, bytes: 0, gone: true };
  }
  try {
    unlinkSync(path);
    return { ok: true, bytes, gone: false };
  } catch {
    return { ok: false, bytes: 0, gone: false };
  }
}

/**
 * One sweep. Safe to call repeatedly and safe to call concurrently with
 * uploads — see RECONCILE_MIN_AGE_MS for the only race there is.
 *
 * `now` is injected so a test can age files past the grace period without
 * sleeping for an hour.
 */
export function sweepAttachments(
  db: Database.Database,
  /** The instance's data dir, PASSED not read. `process.env.MUXPAD_DATA_DIR`
   *  is ambient process state — it is why the e2e suite has to run serially —
   *  and a reaper that deletes files is the last place to inherit it. */
  dataDir: string,
  now: number = Date.now(),
): AttachmentSweepResult {
  const out: AttachmentSweepResult = { unlinked: 0, reconciled: 0, bytes: 0, retained: 0 };

  // ── 1 · drain the queue ───────────────────────────────────────────────────
  // A path that got RE-USED between the delete and the sweep must not be
  // unlinked: the queue says "this path was freed", and a live row saying
  // otherwise is the more recent fact. Cheap to check and impossible to
  // recover from if skipped.
  const live = db.prepare('SELECT 1 FROM attachments WHERE path = ?');
  const queued = db.prepare('SELECT path FROM pending_attachment_unlinks').all() as Array<{
    path: string;
  }>;
  const drop = db.prepare('DELETE FROM pending_attachment_unlinks WHERE path = ?');
  for (const { path } of queued) {
    if (live.get(path)) {
      drop.run(path);
      continue;
    }
    const r = removeFile(path);
    if (r.ok) {
      drop.run(path);
      if (!r.gone) out.unlinked++;
      out.bytes += r.bytes;
    } else {
      out.retained++;
    }
  }

  // ── 2 · reconcile ─────────────────────────────────────────────────────────
  const dir = join(dataDir, 'attachments');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // no directory yet — nothing to reconcile
  }
  // One query, not one per file: a directory of several thousand against a
  // table of several hundred is the common shape, and the per-file version
  // spends a prepared-statement round trip on each miss.
  const referenced = new Set(
    (db.prepare('SELECT path FROM attachments').all() as Array<{ path: string }>).map((r) =>
      r.path.slice(r.path.lastIndexOf('/') + 1),
    ),
  );
  for (const name of names) {
    if (referenced.has(name)) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime < RECONCILE_MIN_AGE_MS) continue;
    const r = removeFile(path);
    if (r.ok && !r.gone) {
      out.reconciled++;
      out.bytes += r.bytes;
    }
  }
  return out;
}

/**
 * Run it at boot and on a slow timer.
 *
 * SLOW on purpose — hourly, not the kill queue's minute. A straggler pty is
 * burning CPU and holding a port, so it is worth chasing; a straggler FILE is
 * only taking up disk, and the cost of noticing it late is a few megabytes. The
 * boot sweep is the one that matters, because that is when a restart has just
 * replayed every delete that happened while the process was down.
 */
export function startAttachmentReaper(deps: {
  db: Database.Database;
  dataDir: string;
  sweepMs?: number;
}): void {
  const run = () => {
    try {
      const r = sweepAttachments(deps.db, deps.dataDir);
      if (r.unlinked || r.reconciled || r.retained)
        console.log(
          `[attachments] freed ${(r.bytes / 1048576).toFixed(1)} MB ` +
            `(${r.unlinked} queued, ${r.reconciled} orphaned, ${r.retained} retried later)`,
        );
    } catch (e) {
      // NEVER throws into the caller: this is housekeeping, and a server that
      // refuses to boot because a file could not be deleted is a worse failure
      // than the disk it was trying to save.
      console.error('[attachments] sweep failed', e);
    }
  };
  setInterval(run, deps.sweepMs ?? 60 * 60 * 1000).unref?.();
  run();
}
