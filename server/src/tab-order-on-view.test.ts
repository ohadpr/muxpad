import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { runMigrations } from './store/migrations.js';
import { reviveChat } from './tab-clock.js';

/**
 * ── LOOKING AT A CHAT IS NOT USING IT ────────────────────────────────────
 *
 * The sidebar sorts on `last_user_at`, and the two VIEW routes stamped it —
 * so opening a chat promoted it above everything you had actually worked in,
 * and the row you left promoted itself the moment you clicked away. Three
 * clicks reshuffled the rail three times: "sidebar reorders too aggressively
 * when just clicking a chat".
 *
 * The column's own documentation already said what belongs in it: acts that
 * restart the decay clock — a message you sent, an unarchive. So the stamp
 * lives in `reviveChat`, which IS both of those, and nowhere else.
 */
let db: Database.Database;
let tab: string;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
  tab = new TabStore(db).create({ name: 'T', layout: 'p', workspace_id: ws }).id;
});

const userAt = () => new TabStore(db).getById(tab)?.last_user_at ?? null;

describe('what moves a chat up the sidebar', () => {
  // A new tab is stamped at creation, so every case here works FORWARD from
  // whatever that was — the column is monotonic and a past timestamp is
  // correctly ignored.
  const born = () => userAt() ?? 0;

  it('a message does — that is the whole point of the column', () => {
    const later = born() + 5_000;
    reviveChat(db, tab, later);
    expect(userAt()).toBe(later);
  });

  it('rides with the decay clock, in one statement', () => {
    // `resetClock` writes `clock_started_at` and `last_user_at` together, by
    // design: the acts that restart the clock ARE the acts the sidebar means
    // by recency, so there is no second call site to forget. That also makes
    // the write unconditional — a revive stamped with an older time moves
    // the column back, which is only reachable by passing a past `at`.
    const t = born() + 4_000;
    reviveChat(db, tab, t);
    expect(userAt()).toBe(t);
    const clock = db.prepare('SELECT clock_started_at AS c FROM tabs WHERE id = ?').get(tab) as {
      c: number | null;
    };
    expect(clock.c).toBe(t);
  });

  it('NO VIEW ROUTE writes it — that is the fix', () => {
    // Asserted against the source, because the routes are the thing that
    // regressed and a round trip through Hono would test the harness.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    for (const f of ['routes/tabs.ts', 'routes/panes.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src.includes('noteUserTouch('), f).toBe(false);
    }
  });
});
