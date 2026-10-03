import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepAttachments } from './attachment-reaper.js';
import { openDb } from './store/db.js';

/**
 * THE BUG THIS FILE IS ABOUT, stated once.
 *
 * `attachments.pane_id` is `ON DELETE CASCADE`. Deleting a pane — or a tab, or
 * a workspace, both of which cascade into panes — removes the attachment ROWS
 * and has never removed the FILES. Measured on a real install: 1493 files
 * against 794 rows, so 699 files and 348 MB unreachable by any query.
 *
 * The fix is a trigger (migration 37) plus this sweeper, and the tests below
 * are written against the CASCADE rather than against a direct
 * `DELETE FROM attachments` — the direct delete is the one path that was never
 * the problem.
 */
describe('the attachment reaper', () => {
  let dir: string;
  let db: Database.Database;

  const HOUR = 60 * 60 * 1000;
  /** For DB columns only. The sweep's `now` is compared against a file's REAL
   *  mtime, so it has to come from the real clock — a fixture timestamp years
   *  away makes every file look ancient and the grace period untestable. */
  const NOW = 1_800_000_000_000;
  /** "Right now" for the sweep: nothing is past the grace period. */
  const sweepNow = () => Date.now();
  /** Far enough past it that everything unreferenced is fair game. */
  const sweepLater = () => Date.now() + 2 * HOUR;

  /** A workspace → tab → pane → attachment chain, the shape a real one has. */
  function seed(name: string): string {
    const path = join(dir, 'attachments', name);
    writeFileSync(path, 'x'.repeat(1024));
    db.prepare(
      'INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(`a-${name}`, 'p1', 'image/png', path, NOW);
    return path;
  }

  const files = () => readdirSync(join(dir, 'attachments')).sort();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'att-reaper-'));
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    db = openDb(join(dir, 'db.sqlite'));
    db.prepare('INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)').run(
      'w1',
      'w1',
      'W',
      NOW,
      NOW,
    );
    db.prepare(
      'INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run('t1', 't1', 'T', 'p1', 'w1', NOW, NOW);
    db.prepare('INSERT INTO panes (id, tab_id, shell, created_at) VALUES (?,?,?,?)').run(
      'p1',
      't1',
      '/bin/zsh',
      NOW,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deleting the PANE takes the file, through the cascade', () => {
    seed('a.png');
    db.prepare('DELETE FROM panes WHERE id = ?').run('p1');
    // The row is already gone — the cascade did that — and the queue is what
    // remembers the path, which is the whole point of the trigger.
    expect(db.prepare('SELECT COUNT(*) c FROM attachments').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM pending_attachment_unlinks').get()).toEqual({ c: 1 });

    const r = sweepAttachments(db, dir, sweepNow());
    expect(r.unlinked).toBe(1);
    expect(files()).toEqual([]);
    // Queue drained, so a second sweep is a no-op rather than a retry forever.
    expect(sweepAttachments(db, dir, sweepNow()).unlinked).toBe(0);
  });

  it('deleting the WORKSPACE takes it too — two cascades deep', () => {
    // The case a fix written into PaneStore.delete would have missed entirely:
    // nothing in the application ever sees this pane die.
    seed('b.png');
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('w1');
    expect(sweepAttachments(db, dir, sweepNow()).unlinked).toBe(1);
    expect(files()).toEqual([]);
  });

  it('does NOT take a file whose path has been re-used by a live row', () => {
    // The queue says "this path was freed"; a live row saying otherwise is the
    // more recent fact, and unlinking here would delete a good attachment.
    const path = seed('c.png');
    db.prepare('DELETE FROM panes WHERE id = ?').run('p1');
    db.prepare('INSERT INTO panes (id, tab_id, shell, created_at) VALUES (?,?,?,?)').run(
      'p2',
      't1',
      '/bin/zsh',
      NOW,
    );
    db.prepare(
      'INSERT INTO attachments (id, pane_id, mime, path, created_at) VALUES (?,?,?,?,?)',
    ).run('a2', 'p2', 'image/png', path, NOW);

    const r = sweepAttachments(db, dir, sweepNow());
    expect(r.unlinked).toBe(0);
    expect(files()).toEqual(['c.png']);
    // …and the stale queue entry is dropped, not left to be re-judged forever.
    expect(db.prepare('SELECT COUNT(*) c FROM pending_attachment_unlinks').get()).toEqual({ c: 0 });
  });

  it('reconciles a file with NO row — which is what the 699 are', () => {
    // They predate the trigger, so no queue entry will ever name them. Only a
    // directory walk can find them.
    writeFileSync(join(dir, 'attachments', 'ghost.png'), 'x'.repeat(2048));
    const r = sweepAttachments(db, dir, sweepLater());
    expect(r.reconciled).toBe(1);
    expect(r.bytes).toBe(2048);
    expect(files()).toEqual([]);
  });

  it('leaves a FRESH unreferenced file alone — the upload race', () => {
    // attachments.ts writes the file and THEN inserts the row, so between those
    // two statements a perfectly good attachment has no row and is
    // indistinguishable from debris. This grace period is the only thing
    // standing between the reaper and deleting what the user just sent.
    writeFileSync(join(dir, 'attachments', 'inflight.png'), 'x');
    const r = sweepAttachments(db, dir, sweepNow());
    expect(r.reconciled).toBe(0);
    expect(files()).toEqual(['inflight.png']);
  });

  it('leaves a REFERENCED file alone however old it is', () => {
    seed('keep.png');
    const r = sweepAttachments(db, dir, sweepLater());
    expect(r.reconciled).toBe(0);
    expect(files()).toEqual(['keep.png']);
  });

  it('treats an already-missing file as success, not as a retry', () => {
    // The goal is that the file not be there. Something else having got to it
    // first satisfies that completely, and a queue that retried forever on it
    // would grow without bound.
    seed('vanished.png');
    rmSync(join(dir, 'attachments', 'vanished.png'));
    db.prepare('DELETE FROM panes WHERE id = ?').run('p1');
    const r = sweepAttachments(db, dir, sweepNow());
    expect(r.retained).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM pending_attachment_unlinks').get()).toEqual({ c: 0 });
  });

  it('survives a missing attachments directory', () => {
    rmSync(join(dir, 'attachments'), { recursive: true, force: true });
    expect(() => sweepAttachments(db, dir, sweepNow())).not.toThrow();
  });
});
