import { CARD_MAX_BYTES } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../events.js';
import { runMigrations } from '../store/migrations.js';
import { cardsRoutes } from './cards.js';

/**
 * The HTTP door onto cards. The store owns the rules (TabCardStore.test.ts);
 * what is asserted here is the door: the right codes, the chat check, the
 * event, and that a refusal reaches the caller as the sentence the store wrote
 * rather than a generic 400.
 */
describe('cards routes', () => {
  let db: Database.Database;
  let events: EventBus;
  let seen: string[];
  let app: ReturnType<typeof cardsRoutes>;
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('w1', 'w1', 'W', NOW, NOW);
    db.prepare(
      `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at)
       VALUES ('t1','t1','T','"p1"','w1',?,?)`,
    ).run(NOW, NOW);
    events = new EventBus();
    seen = [];
    events.subscribe((e) => {
      if (e.type === 'cards.updated') seen.push(e.tab_id);
    });
    app = cardsRoutes({ db, events });
  });

  const put = (name: string, body: unknown, tab = 't1') =>
    app.request(`/${tab}/cards/${name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates with 201, updates with 200, and announces both', async () => {
    const a = await put('build', { content: '10%' });
    expect(a.status).toBe(201);
    const b = await put('build', { content: '62%' });
    expect(b.status).toBe(200);
    expect(await b.json()).toMatchObject({ name: 'build', content: '62%' });
    expect(seen).toEqual(['t1', 't1']);
  });

  it('lists in pinned order', async () => {
    await put('build', { content: 'x' });
    await put('market', { content: 'y' });
    const res = await app.request('/t1/cards');
    const body = (await res.json()) as { cards: Array<{ name: string }> };
    expect(body.cards.map((c) => c.name)).toEqual(['build', 'market']);
  });

  it('reads one back — the half that lets two writers share a card', async () => {
    await put('market', { content: 'open: +0.4%', format: 'markdown' });
    const res = await app.request('/t1/cards/market');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: 'open: +0.4%', format: 'markdown' });
  });

  it('deletes with 204, then 404, and announces only the real one', async () => {
    await put('build', { content: 'x' });
    seen.length = 0;
    expect((await app.request('/t1/cards/build', { method: 'DELETE' })).status).toBe(204);
    expect((await app.request('/t1/cards/build', { method: 'DELETE' })).status).toBe(404);
    // A repaint on every device for a card that was already gone is noise.
    expect(seen).toEqual(['t1']);
  });

  it('404s on a chat that does not exist, rather than an empty list', async () => {
    // An empty list for a typo'd id reads as "this chat has no cards", which is
    // the wrong answer to a different question.
    expect((await app.request('/nope/cards')).status).toBe(404);
    expect((await put('x', { content: 'y' }, 'nope')).status).toBe(404);
  });

  it('404s on an unknown card', async () => {
    expect((await app.request('/t1/cards/ghost')).status).toBe(404);
  });

  it("relays the store's own refusal, not a generic 400", async () => {
    const res = await put('has space', { content: 'x' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/card name/);
  });

  it('refuses oversized content with a sentence that says what to do', async () => {
    const res = await put('big', { content: 'x'.repeat(CARD_MAX_BYTES + 1) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/publish/);
  });

  it('rejects a malformed body', async () => {
    expect((await put('c', { nope: 1 })).status).toBe(400);
    const res = await app.request('/t1/cards/c', { method: 'PUT' });
    expect(res.status).toBe(400);
  });

  it('does not announce a write that was refused', async () => {
    await put('has space', { content: 'x' });
    expect(seen).toEqual([]);
  });

  it('works with no event bus at all', async () => {
    const bare = cardsRoutes({ db });
    expect(
      (
        await bare.request('/t1/cards/c', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'x' }),
        })
      ).status,
    ).toBe(201);
  });

  it('never throws a listener failure into the caller', async () => {
    const noisy = new EventBus();
    noisy.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const a = cardsRoutes({ db, events: noisy });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await a.request('/t1/cards/c', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(201);
    spy.mockRestore();
  });
});
