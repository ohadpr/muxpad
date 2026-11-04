import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queuePaneKill } from './pane-reaper.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';

let dir: string;
let db: Database.Database;
let paneId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-reaper-'));
  db = openDb(join(dir, 'db.sqlite'));
  const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  const tab = new TabStore(db).create({ name: 'T', layout: '', workspace_id: ws }).id;
  paneId = new PaneStore(db).create({ tab_id: tab, shell: '/bin/zsh', cwd: '/tmp' }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tombstone = () =>
  db.prepare('SELECT node_id FROM pending_pane_kills WHERE pane_id = ?').get(paneId) as
    | { node_id: string }
    | undefined;

const onNode = (n: string) =>
  db.prepare('UPDATE panes SET node_id = ? WHERE id = ?').run(n, paneId);

/**
 * ── A TOMBSTONE MUST REMEMBER WHICH MACHINE ──────────────────────────────
 *
 * By the time a kill is queued the pane row is usually GONE — that is the
 * situation the queue exists for. So the node cannot be looked up later: an
 * unknown pane reads as `local`, the retry goes to the mac, ptyd answers
 * "unknown id" as an idempotent SUCCESS, the tombstone is cleared, and the
 * process on the other machine is orphaned with nothing left that knows about
 * it.
 */
describe('queued kills carry their node', () => {
  it('records the node at QUEUE time, while the row still exists', () => {
    onNode('trayo');
    queuePaneKill(db, paneId);
    expect(tombstone()?.node_id).toBe('trayo');
  });

  it('survives the row being deleted — which is the whole point', () => {
    onNode('trayo');
    queuePaneKill(db, paneId);
    db.prepare('DELETE FROM panes WHERE id = ?').run(paneId);
    expect(tombstone()?.node_id).toBe('trayo'); // still knows, with no row to ask
  });

  it('accepts an explicit node, for a caller that already read the row', () => {
    queuePaneKill(db, paneId, 'trayo');
    expect(tombstone()?.node_id).toBe('trayo');
  });

  it('defaults to local, which is what every pre-existing entry was', () => {
    queuePaneKill(db, paneId);
    expect(tombstone()?.node_id).toBe('local');
  });

  it('re-queuing updates in place rather than duplicating', () => {
    queuePaneKill(db, paneId);
    queuePaneKill(db, paneId, 'trayo');
    const n = db.prepare('SELECT COUNT(*) AS n FROM pending_pane_kills').get() as { n: number };
    expect(n.n).toBe(1);
    expect(tombstone()?.node_id).toBe('trayo');
  });

  it('never throws — a failed tombstone must not break a delete', () => {
    // It is called from cascade paths that have already committed.
    db.exec('DROP TABLE pending_pane_kills');
    expect(() => queuePaneKill(db, paneId)).not.toThrow();
  });
});
