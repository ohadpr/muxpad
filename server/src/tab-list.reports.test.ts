import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PtydCache } from './ptyd-cache.js';
import { runMigrations } from './store/migrations.js';
import { orderedTabsForWorkspace } from './tab-list.js';

/** Bulk lists omit prose; parent-scoped detail owns complete reports. */
let db: Database.Database;
let cache: PtydCache;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  cache = new PtydCache();
  db.prepare(
    'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,0,0,0)',
  ).run('w1', 'w1', 'W1');
  db.prepare(
    `INSERT INTO tabs (id, slug, name, workspace_id, layout, position, created_at, updated_at,
                       spawn_report, spawn_report_state, spawn_report_at)
     VALUES ('t1','t1','Worker','w1','{}',0,0,0,?,?,?)`,
  ).run('A long summary of everything the worker did.', 'ok', 1234);
});

const row = (opts?: { omitReportText?: boolean }) =>
  orderedTabsForWorkspace(db, cache, 'w1', undefined, opts)[0] as Record<string, unknown>;

describe('report text on the tab list', () => {
  it('is present by default for detail readers', () => {
    expect(row().spawn_report).toBe('A long summary of everything the worker did.');
  });

  it('is gone when the caller asks for it to be', () => {
    expect(row({ omitReportText: true }).spawn_report).toBeUndefined();
  });

  it('keeps the STATE and the TIMESTAMP, which is what says a report exists', () => {
    // Drop these too and a finished worker reads as one that produced
    // nothing, which is a lie the card would tell confidently.
    const r = row({ omitReportText: true });
    expect(r.spawn_report_state).toBe('ok');
    expect(r.spawn_report_at).toBe(1234);
  });

  it('changes nothing else about the row', () => {
    const full = row();
    const slim = row({ omitReportText: true });
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
    expect(keys(full).filter((k) => k !== 'spawn_report')).toEqual(keys(slim));
    for (const k of keys(slim)) expect(slim[k]).toEqual(full[k]);
  });

  it('leaves a row that never had a report alone', () => {
    db.prepare(
      `INSERT INTO tabs (id, slug, name, workspace_id, layout, position, created_at, updated_at)
       VALUES ('t2','t2','Plain','w1','{}',1,0,0)`,
    ).run();
    const plain = orderedTabsForWorkspace(db, cache, 'w1', undefined, {
      omitReportText: true,
    }).find((t) => t.id === 't2');
    expect(plain).toBeDefined();
    expect(plain?.name).toBe('Plain');
  });
});
