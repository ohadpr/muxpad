import { CARD_MAX_BYTES, CARD_MAX_PER_TAB, cardIsStale } from '@muxpad/shared';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { TabCardStore } from './TabCardStore.js';
import { runMigrations } from './migrations.js';

/**
 * Cards: a value held still, against a transcript that can only append.
 *
 * The claim that matters most is the UPSERT — a writer calls `set` with the
 * same name over and over, and a card is updated rather than a list grown. Get
 * that wrong and cards reproduce the exact problem they exist to fix.
 */
describe('TabCardStore', () => {
  let db: Database.Database;
  let cards: TabCardStore;
  const NOW = 1_800_000_000_000;

  const tab = (id: string) =>
    db
      .prepare(
        `INSERT INTO tabs (id, slug, name, layout, workspace_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, id, id, JSON.stringify(`p-${id}`), 'w1', NOW, NOW);

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('w1', 'w1', 'W', NOW, NOW);
    tab('t1');
    tab('t2');
    cards = new TabCardStore(db);
  });

  const ok = (r: ReturnType<TabCardStore['set']>) => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    return r;
  };

  it('UPDATES IN PLACE on the same name — the whole point', () => {
    const a = ok(cards.set({ tabId: 't1', name: 'build', content: '10%', at: NOW }));
    const b = ok(cards.set({ tabId: 't1', name: 'build', content: '62%', at: NOW + 5 }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.card.id).toBe(a.card.id);
    expect(cards.list('t1')).toHaveLength(1);
    expect(cards.get('t1', 'build')?.content).toBe('62%');
  });

  it('keeps created_at while moving updated_at', () => {
    ok(cards.set({ tabId: 't1', name: 'build', content: 'a', at: NOW }));
    const b = ok(cards.set({ tabId: 't1', name: 'build', content: 'b', at: NOW + 900 }));
    expect(b.card.created_at).toBe(NOW);
    expect(b.card.updated_at).toBe(NOW + 900);
  });

  it('holds several named cards per chat, oldest first', () => {
    ok(cards.set({ tabId: 't1', name: 'build', content: 'x', at: NOW }));
    ok(cards.set({ tabId: 't1', name: 'market', content: 'y', at: NOW + 1 }));
    expect(cards.list('t1').map((c) => c.name)).toEqual(['build', 'market']);
  });

  it('scopes to the chat — one chat cannot see another is cards', () => {
    ok(cards.set({ tabId: 't1', name: 'build', content: 'mine', at: NOW }));
    expect(cards.get('t2', 'build')).toBeNull();
    expect(cards.list('t2')).toEqual([]);
  });

  it('remembers the format, and lets a later write change it', () => {
    ok(cards.set({ tabId: 't1', name: 'c', content: '<b>x</b>', format: 'html', at: NOW }));
    // A content-only update must not silently downgrade an html card to text.
    const b = ok(cards.set({ tabId: 't1', name: 'c', content: '<b>y</b>', at: NOW + 1 }));
    expect(b.card.format).toBe('html');
    const c = ok(
      cards.set({ tabId: 't1', name: 'c', content: 'plain', format: 'text', at: NOW + 2 }),
    );
    expect(c.card.format).toBe('text');
  });

  it('leaves the cadence alone unless the writer states one', () => {
    ok(cards.set({ tabId: 't1', name: 'm', content: 'a', everyMs: 86_400_000, at: NOW }));
    const b = ok(cards.set({ tabId: 't1', name: 'm', content: 'b', at: NOW + 1 }));
    expect(b.card.every_ms).toBe(86_400_000);
    const c = ok(cards.set({ tabId: 't1', name: 'm', content: 'c', everyMs: null, at: NOW + 2 }));
    expect(c.card.every_ms).toBeNull();
  });

  it('clears one card and leaves the rest', () => {
    ok(cards.set({ tabId: 't1', name: 'a', content: '1', at: NOW }));
    ok(cards.set({ tabId: 't1', name: 'b', content: '2', at: NOW }));
    expect(cards.clear('t1', 'a')).toBe(true);
    expect(cards.clear('t1', 'a')).toBe(false); // already gone
    expect(cards.list('t1').map((c) => c.name)).toEqual(['b']);
  });

  it('goes with the chat — no card outlives its conversation', () => {
    ok(cards.set({ tabId: 't1', name: 'a', content: '1', at: NOW }));
    db.prepare('DELETE FROM tabs WHERE id = ?').run('t1');
    expect(cards.list('t1')).toEqual([]);
  });

  describe('what it refuses', () => {
    it('a name that is not an identity', () => {
      for (const name of ['', '   ', 'has space', 'a'.repeat(41), '-leading', 'x/y']) {
        expect(cards.set({ tabId: 't1', name, content: 'x' }).ok).toBe(false);
      }
    });

    it('accepts the names people actually use', () => {
      for (const name of ['build', 'market', 'v2.1', 'deploy-prod', 'a', 'S4_status']) {
        expect(cards.set({ tabId: 't1', name, content: 'x' }).ok).toBe(true);
        cards.clear('t1', name);
      }
    });

    it('content past the cap, measured in BYTES', () => {
      // The cap bounds what crosses the wire into a pinned element; one emoji
      // is four bytes, so counting characters would under-measure by 4x.
      const emoji = '😀'.repeat(CARD_MAX_BYTES / 4);
      expect(emoji.length).toBeLessThan(CARD_MAX_BYTES);
      const r = cards.set({ tabId: 't1', name: 'big', content: `${emoji}x` });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/cap/);
    });

    it('a new card past the per-chat cap — but still updates existing ones', () => {
      for (let i = 0; i < CARD_MAX_PER_TAB; i++) {
        expect(cards.set({ tabId: 't1', name: `c${i}`, content: 'x' }).ok).toBe(true);
      }
      expect(cards.set({ tabId: 't1', name: 'one-more', content: 'x' }).ok).toBe(false);
      // A writer at the cap must still be able to update what it already owns,
      // or a full chat silently stops reporting.
      expect(cards.set({ tabId: 't1', name: 'c0', content: 'updated' }).ok).toBe(true);
    });
  });

  it('reads an unknown stored format as text rather than guessing markup', () => {
    ok(cards.set({ tabId: 't1', name: 'c', content: 'x', at: NOW }));
    db.prepare("UPDATE tab_cards SET format = 'mermaid' WHERE tab_id='t1' AND name='c'").run();
    expect(cards.get('t1', 'c')?.format).toBe('text');
  });
});

describe('cardIsStale', () => {
  const card = (every: number | null, updated: number) => ({
    every_ms: every,
    updated_at: updated,
  });

  it('a card with no declared cadence is never late', () => {
    expect(cardIsStale(card(null, 0), 1e12)).toBe(false);
    expect(cardIsStale(card(0, 0), 1e12)).toBe(false);
  });

  it('is not late a moment after its cadence', () => {
    // A daily card written at 06:42 and again at 06:43 is not late, and
    // flagging it would train you to ignore the flag.
    const day = 86_400_000;
    expect(cardIsStale(card(day, 0), day + 60_000)).toBe(false);
  });

  it('is late once it has plainly MISSED', () => {
    const day = 86_400_000;
    expect(cardIsStale(card(day, 0), day * 2)).toBe(true);
  });
});
