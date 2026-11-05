import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { ChatActionStore } from '../store/ChatActionStore.js';
import { PaneStore } from '../store/PaneStore.js';

/**
 * WHAT THIS CHAT DID OUTSIDE ITSELF — `GET /api/panes/:id/actions`.
 *
 * ── A POLL, AND THE SAME REASONING AS THE BROWSER CARDS ──────────────────
 * The state that matters ("did that message go?") is a fact on the server, and
 * the whole point of the card is that you learn it by LOOKING rather than by
 * having been present when it happened. A poll is correct after a reload,
 * after a reconnect, and on a phone that was asleep; a subscription is correct
 * only while it is connected, which is exactly when you did not need it.
 *
 * Read-only. An act is recorded by whatever performed it — a card is a record,
 * and a POST here would be a way to write history that never happened.
 */
export function chatActionsRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();

  app.get('/:id/actions', (c) => {
    const paneId = c.req.param('id');
    // A pane that is gone has no chat to draw into; 404 rather than an empty
    // list, so a client can tell "nothing happened here" from "no such chat".
    if (!new PaneStore(deps.db).getById(paneId))
      return c.json({ error: { code: 'not_found', message: 'no such pane' } }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({ actions: new ChatActionStore(deps.db).listForPane(paneId) });
  });

  return app;
}
