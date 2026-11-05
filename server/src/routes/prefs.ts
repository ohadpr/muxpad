import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EventBus } from '../events.js';
import { MAX_PREF_BYTES, PrefStore, isPrefKey } from '../store/PrefStore.js';

/**
 * `GET /api/prefs` and `PUT /api/prefs/:key` — the install's own settings.
 *
 * A write PUSHES the whole set on the event bus, which is what makes "pick a
 * theme and every open window changes" true without a poll: every client holds
 * an events subscription already, and the theme is a document-level fact that
 * has to land everywhere at once.
 *
 * The key space is a whitelist in PrefStore. Without one this is an arbitrary
 * broadcast channel with a database behind it.
 */
export function prefsRoutes(deps: { db: Database.Database; events: EventBus }): Hono {
  const app = new Hono();
  const store = () => new PrefStore(deps.db);

  app.get('/', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ prefs: store().all() });
  });

  app.put('/:key', async (c) => {
    const key = c.req.param('key');
    if (!isPrefKey(key))
      return c.json({ error: { code: 'not_found', message: 'no such preference' } }, 404);
    const parsed = z
      // `null` is a real value: back to the client's own default, which is the
      // ABSENCE of a row rather than an empty string.
      .object({ value: z.string().nullable() })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_request', message: 'value is required' } }, 400);
    const value = parsed.data.value;
    if (value !== null && Buffer.byteLength(value, 'utf8') > MAX_PREF_BYTES)
      return c.json(
        { error: { code: 'invalid_request', message: `value exceeds ${MAX_PREF_BYTES} bytes` } },
        400,
      );
    const s = store();
    if (value === null) s.clear(key);
    else s.set(key, value);
    const prefs = s.all();
    deps.events.emit({ type: 'prefs.updated', prefs });
    return c.json({ prefs });
  });

  return app;
}
