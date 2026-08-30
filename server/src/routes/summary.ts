import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { summarizePane } from '../chat/summarize.js';

/**
 * Summarize an agent pane's conversation down to its DELIVERABLE, for the
 * document surface's collapse-to-summary. This is the whole product bet: a
 * collapsed agent block should show WHAT you got, not the pages of work it took
 * — chat buries the payload, this surfaces it.
 *
 * The work itself lives in chat/summarize.ts, shared with the cron scheduler's
 * `on_context=rotate` handoff. Deliberately best-effort: every failure path
 * returns an empty summary so the client falls back to a raw snippet rather
 * than erroring — a missing summary must never break the document.
 */
export function summaryRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();

  app.post('/:id/summarize', async (c) => {
    return c.json(await summarizePane(deps.db, c.req.param('id')));
  });

  return app;
}
