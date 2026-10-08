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

  app.delete('/:tabId/cards/:name', (c) => {
    const tabId = c.req.param('tabId');
    if (!haveTab(tabId)) return c.json(bad('no such chat'), 404);
    const gone = cards.clear(tabId, c.req.param('name'));
    // Only on a real deletion: an event per no-op is a repaint per no-op on
    // every connected device.
    if (gone) announce(tabId);
    return gone ? c.body(null, 204) : c.json(bad('no such card'), 404);
  });

  return app;
}
