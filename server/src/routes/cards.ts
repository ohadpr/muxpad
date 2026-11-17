import { CardFormatSchema } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EventBus } from '../events.js';
import { TabCardStore } from '../store/TabCardStore.js';
import { TabStore } from '../store/TabStore.js';

const SetSchema = z.object({
  content: z.string(),
  format: CardFormatSchema.optional(),
  /** ms between expected writes; null clears the expectation, absent leaves it. */
  every_ms: z.number().int().positive().nullable().optional(),
});

/**
 * REST for `muxpad card` — see shared/src/cards.ts for what a card is.
 *
 * Mounted under /api/tabs because a card belongs to a CHAT, and a chat is a
 * tab. The CLI passes `MUXPAD_TAB_ID`, which ptyd already puts in every pane's
 * environment, so a writer inside a chat names no id at all.
 *
 * Thin by construction: every limit and the upsert itself live in
 * TabCardStore, so the HTTP door and any other caller get one answer. What
 * lives here is the tab check and the event.
 */
/**
 * The schedules muxpad can SEE that name this card.
 *
 * Three ways a cron can be bound to a card, and the database holds only two
 * of them: the `--card=` column, and a `muxpad card set <name>` written into
 * the prompt. The third — a cron that runs a script which writes the card —
 * leaves the card's name nowhere at all. Measured here: `nw-open` and
 * `nw-close` keep the market card fresh by running `scripts/market_card.sh`,
 * and a text search for "market" finds neither.
 *
 * So this is a HINT for the message, never an inventory, and the message says
 * so rather than implying the list is the answer.
 *
 * PAUSED ONES COUNT. A disabled cron cannot bring the card back today, but it
 * is litter named for something that no longer exists, and somebody resuming
 * it later gets a job writing a card nobody kept. The caller is told which is
 * which.
 */
export function cardWriters(
  db: Database.Database,
  card: string,
): Array<{ name: string; enabled: boolean }> {
  try {
    // `_` and `%` are LIKE wildcards and both are legal in a card name, so the
    // pattern escapes them — without this, a card called `a_b` would claim the
    // schedules of `axb`.
    const like = `%${card.replace(/([\\%_])/g, '\\$1')}%`;
    return (
      db
        .prepare(
          `SELECT name, enabled FROM crons
             WHERE card = ?
                OR prompt LIKE ? ESCAPE '\\'
             ORDER BY enabled DESC, name`,
        )
        .all(card, like) as Array<{ name: string; enabled: number }>
    ).map((r) => ({ name: r.name, enabled: r.enabled === 1 }));
  } catch {
    // An older database with no `card` column must not break a deletion: the
    // card still goes, the chat just hears nothing about writers.
    return [];
  }
}

export function cardsRoutes(deps: { db: Database.Database; events?: EventBus | undefined }): Hono {
  const app = new Hono();
  const cards = new TabCardStore(deps.db);
  const tabs = new TabStore(deps.db);

  const bad = (message: string) => ({ error: { code: 'bad_request' as const, message } });

  /** Tell every connected device this chat's cards moved. Thin — see the
   *  event's own note: the client re-fetches rather than trusting a payload. */
  const announce = (tabId: string) => deps.events?.emit({ type: 'cards.updated', tab_id: tabId });

  /** A card on a tab that does not exist is a typo, not an empty list. */
  const haveTab = (tabId: string) => tabs.getById(tabId) !== null;

  app.get('/:tabId/cards', (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    return c.json({ cards: cards.list(tabId) });
  });

  app.get('/:tabId/cards/:name', (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    const card = cards.get(tabId, c.req.param('name'));
    return card ? c.json(card) : c.json(bad('no such card'), 404);
  });

  app.put('/:tabId/cards/:name', async (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    const parsed = SetSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad('body must be {content, format?, every_ms?}'), 400);
    const r = cards.set({
      tabId,
      name: c.req.param('name'),
      content: parsed.data.content,
      ...(parsed.data.format ? { format: parsed.data.format } : {}),
      ...(parsed.data.every_ms !== undefined ? { everyMs: parsed.data.every_ms } : {}),
    });
    // The store's refusals are the user-facing ones (name shape, size cap, per
    // chat cap), so its sentence is relayed verbatim rather than re-worded into
    // something less specific.
    if (!r.ok) return c.json(bad(r.reason), 400);
    announce(tabId);
    return c.json(r.card, r.created ? 201 : 200);
  });

  /**
   * Remove a card — and say WHO STILL WRITES IT.
   *
   * A card is usually kept fresh by a schedule (`cron new --card=<name>`), and
   * deleting the card alone leaves that running: the card returns on the next
   * fire, which reads as the button being broken. The caller cannot know that
   * on its own, and an agent sent looking for it will sometimes look wrong, so
   * the deletion answers with the schedules carrying this card's name.
   *
   * 200 with a body rather than 204, because an answer with nothing in it was
   * the old contract and the writers are the whole point of the new one.
   */
  app.delete('/:tabId/cards/:name', (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    const name = c.req.param('name');
    const gone = cards.clear(tabId, name);
    // Only on a real deletion: an event per no-op is a repaint per no-op on
    // every connected device.
    if (gone) announce(tabId);
    if (!gone) return c.json(bad('no such card'), 404);
    return c.json({ writers: cardWriters(deps.db, name) });
  });

  return app;
}
