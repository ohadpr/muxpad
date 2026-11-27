import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './store/migrations.js';
import { clockSnapshot, liveChildCount, liveChildTabs } from './tab-clock.js';

/**
 * THE CHILD LOOKUP WAS QUADRATIC IN CHATS-EVER-CREATED.
 *
 * `liveChildTabs` answered "which children of this tab are live" by walking
 * the whole clock index, and a list decorates every row. On the live install
 * that was 1,149 rows × 1,549 indexed tabs — ~1.8 million iterations per
 * request, each a string compare plus a clock resolve. Measured by review at
 * 17.6 ms CPU for one workspace, against 0.34 ms to build a parent→children
 * map and answer every row from it.
 *
 * It grew with the number of chats ever made (~25/day here), so it got worse
 * on its own every day. These hold the map to the SAME ANSWERS as the scan,
 * because a faster function that is wrong is not a fix.
 */
let db: Database.Database;

const mkTab = (id: string, spawnedBy: string | null = null, retiredAt: number | null = null) =>
  db
    .prepare(
      `INSERT INTO tabs (id, slug, name, workspace_id, layout, position, created_at, updated_at,
                         spawned_by, retired_at, clock_started_at)
       VALUES (?,?,?, 'w1', '{}', 0, 0, 0, ?, ?, ?)`,
    )
    .run(id, id, id, spawnedBy, retiredAt, Date.now());

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,0,0,0)',
  ).run('w1', 'w1', 'W1');
});

describe('children of a chat', () => {
  it('finds them, and only them', () => {
    mkTab('parent');
    mkTab('other');
    mkTab('kid1', 'parent');
    mkTab('kid2', 'parent');
    mkTab('notmine', 'other');
    const s = clockSnapshot(db);
    expect(liveChildTabs(s.index, 'parent', s.now, s.childrenOf).sort()).toEqual(['kid1', 'kid2']);
    expect(liveChildCount(s.index, 'parent', s.now, s.childrenOf)).toBe(2);
  });

  it('answers the same with the map as without it — that is the whole claim', () => {
    mkTab('p1');
    mkTab('p2');
    for (let i = 0; i < 25; i++) mkTab(`a${i}`, 'p1');
    for (let i = 0; i < 10; i++) mkTab(`b${i}`, 'p2');
    const s = clockSnapshot(db);
    for (const id of ['p1', 'p2', 'a0', 'nonexistent']) {
      const scanned = liveChildTabs(s.index, id, s.now).sort();
      const mapped = liveChildTabs(s.index, id, s.now, s.childrenOf).sort();
      expect(mapped, id).toEqual(scanned);
    }
  });

  it('a chat that spawned nothing has no children, not an error', () => {
    mkTab('lonely');
    const s = clockSnapshot(db);
    expect(liveChildTabs(s.index, 'lonely', s.now, s.childrenOf)).toEqual([]);
    expect(liveChildCount(s.index, 'lonely', s.now, s.childrenOf)).toBe(0);
  });

  it('keys only the parents — not an entry per tab', () => {
    // An empty list for every childless chat would be a map the size of the
    // table, which is the allocation this was meant to avoid.
    mkTab('p');
    mkTab('kid', 'p');
    for (let i = 0; i < 50; i++) mkTab(`plain${i}`);
    expect(clockSnapshot(db).childrenOf.size).toBe(1);
  });

  it('leaves a retired child out, exactly as the scan did', () => {
    mkTab('p');
    mkTab('live', 'p');
    mkTab('gone', 'p', Date.now() - 1000);
    const s = clockSnapshot(db);
    expect(liveChildTabs(s.index, 'p', s.now, s.childrenOf)).toEqual(['live']);
    // …and the slow path agrees, so the two cannot drift silently.
    expect(liveChildTabs(s.index, 'p', s.now)).toEqual(['live']);
  });
});
