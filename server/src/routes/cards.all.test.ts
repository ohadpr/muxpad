import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { TabCardStore } from '../store/TabCardStore.js';
import { runMigrations } from '../store/migrations.js';
import { allCardsRoutes } from './cards.js';

/**
 * The cards PAGE's one endpoint. What it must get right is the join: a card
 * carries the chat it lives in, because every row on that page has to be able
 * to take you back there, and looking the chat up per row is the N+1 that
 * already cost the workspace list 1,038 queries for a 763-byte answer.
 */
let db: Database.Database;
let app: Hono;

const ws = (id: string, slug: string, name: string) =>
  db
    .prepare(
      'INSERT INTO workspaces (id, slug, name, position, created_at, updated_at) VALUES (?,?,?,0,0,0)',
    )
    .run(id, slug, name);

const tab = (id: string, wsId: string, name: string, retiredAt: number | null = null) =>
  db
    .prepare(
      `INSERT INTO tabs (id, slug, name, workspace_id, layout, position, created_at, updated_at, retired_at)
       VALUES (?,?,?,?,'{}',0,0,0,?)`,
    )
    .run(id, `s-${id}`, name, wsId, retiredAt);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  app = new Hono();
  app.route('/api/cards', allCardsRoutes({ db }));
  ws('w1', 'personal', 'Personal');
});

const list = async () => {
  const res = await app.request('/api/cards');
  return (await res.json()) as { cards: Array<Record<string, unknown>> };
};

describe('GET /api/cards', () => {
  it('is empty, not an error, on an install with no cards', async () => {
    expect((await list()).cards).toEqual([]);
  });

  it('carries the chat each card lives in', async () => {
    tab('t1', 'w1', 'Investing');
    new TabCardStore(db).set({ tabId: 't1', name: 'market', content: 'x', format: 'html' });
    const [card] = (await list()).cards;
    expect(card?.name).toBe('market');
    expect(card?.chat).toMatchObject({
      tabId: 't1',
      name: 'Investing',
      slug: 's-t1',
      workspaceSlug: 'personal',
      retired: false,
    });
  });

  it('spans chats and workspaces — that is the whole point', async () => {
    ws('w2', 'trayo', 'Trayo');
    tab('t1', 'w1', 'Investing');
    tab('t2', 'w2', 'Office');
    const store = new TabCardStore(db);
    store.set({ tabId: 't1', name: 'market', content: 'a', at: 100 });
    store.set({ tabId: 't2', name: 'dev-server', content: 'b', at: 200 });
    const names = (await list()).cards.map((c) => c.name);
    expect(new Set(names)).toEqual(new Set(['market', 'dev-server']));
  });

  it('is newest first — the page reads as what has happened', async () => {
    tab('t1', 'w1', 'Investing');
    const store = new TabCardStore(db);
    store.set({ tabId: 't1', name: 'old', content: 'a', at: 100 });
    store.set({ tabId: 't1', name: 'new', content: 'b', at: 999 });
    expect((await list()).cards.map((c) => c.name)).toEqual(['new', 'old']);
  });

  it('marks a card whose chat has been archived', async () => {
    tab('t1', 'w1', 'Finished thing', 12345);
    new TabCardStore(db).set({ tabId: 't1', name: 'leftover', content: 'x' });
    // The page groups these away from the values actually being watched; it
    // needs the fact, not a guess from the card's own age.
    expect((await list()).cards[0]?.chat).toMatchObject({ retired: true });
  });

  it('a card cannot outlive its chat, which is why the join is safe', async () => {
    tab('t1', 'w1', 'Doomed');
    new TabCardStore(db).set({ tabId: 't1', name: 'ghost', content: 'x' });
    db.prepare('DELETE FROM tabs WHERE id = ?').run('t1');
    expect((await list()).cards).toEqual([]);
    // AND THE REASON MATTERS, because the first version of this test got it
    // wrong: it claimed the inner join dropped the orphan, and stayed green
    // with BOTH joins turned into LEFT JOINs. It is `tab_cards.tab_id
    // REFERENCES tabs(id) ON DELETE CASCADE` that does it — there is never an
    // orphan to drop. So the inner join cannot lose a card, which is the
    // thing worth knowing, and it is pinned here rather than assumed.
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'tab_cards'`).get() as {
      sql: string;
    };
    expect(ddl.sql).toMatch(/REFERENCES\s+tabs\(id\)\s+ON DELETE CASCADE/i);
  });
});
