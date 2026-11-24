import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PtydCache } from './ptyd-cache.js';
import { runMigrations } from './store/migrations.js';
import { REPORT_EXCERPT_CHARS, orderedTabsForWorkspace } from './tab-list.js';

/**
 * THE SIDEBAR'S LIST DOES NOT CARRY A WORKER'S PROSE.
 *
 * `spawn_report` is a finished worker's whole summary. Measured on the live
 * install: 479 KB of a 1.19 MB answer over 1,136 rows — 56.5% — on the route
 * the sidebar re-polls 250ms after every `pane.updated` edge, to each of 98
 * connections, while forty agents make those edges continuously.
 *
 * Nobody on that route reads it: it feeds row names, states and clocks. The
 * surface that renders report prose is the spawn card, whose corpus is
 * `/api/tabs/all`, which still carries it. These assertions hold both halves
 * of that, because dropping it from BOTH would silently turn every finished
 * worker's card into "Finished with nothing to report".
 */
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

const row = (opts?: { omitReportText?: boolean; excerptReportText?: boolean }) =>
  orderedTabsForWorkspace(db, cache, 'w1', undefined, opts)[0] as Record<string, unknown>;

describe('report text on the tab list', () => {
  it('is present by default — the corpus route depends on it', () => {
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

  it('excerpts rather than drops, for the corpus', () => {
    // The corpus is the one list that needs report text - it draws the card.
    // It was carrying the WHOLE report for 1,628 rows: 712 KB of 1.76 MB,
    // walking the answer into json-cache's 2 MB buffering cap, above which
    // it ships raw and uncompressed two to four times per chat opened.
    const long = 'x'.repeat(1000);
    db.prepare('UPDATE tabs SET spawn_report = ? WHERE id = ?').run(long, 't1');
    const r = row({ excerptReportText: true });
    const text = r.spawn_report as string;
    expect(text.length).toBe(REPORT_EXCERPT_CHARS + 1); // + the ellipsis
    expect(text.endsWith('…')).toBe(true);
  });

  it('leaves a SHORT report exactly as it is, ellipsis included', () => {
    // An ellipsis on a complete report would be a lie about there being more.
    const r = row({ excerptReportText: true });
    expect(r.spawn_report).toBe('A long summary of everything the worker did.');
  });

  it('never excerpts to nothing — an empty report is a different fact', () => {
    // `spawnCardSummary` says "Finished with nothing to report" for a report
    // with no text, so a list that dropped the text would make every finished
    // worker look like it produced nothing until its rounds arrived.
    const r = row({ excerptReportText: true });
    expect(r.spawn_report).toBeTruthy();
    expect(r.spawn_report_state).toBe('ok');
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
