import type { MuxpadEvent } from '@muxpad/shared';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { PrefStore } from '../store/PrefStore.js';
import { openDb } from '../store/db.js';
import { prefsRoutes } from './prefs.js';

/**
 * ONE THEME FOR THE INSTALL, and the push is the feature.
 *
 * "pick a theme — all open muxpad windows change to that theme no matter what
 * chat they are on." Every client already holds an events subscription, so a
 * write that emits is a write that lands everywhere; a write that only stored
 * would need a poll, and a theme is a document-level fact that cannot flicker
 * in one window for five seconds.
 */

let db: ReturnType<typeof openDb>;
let app: Hono;
let seen: MuxpadEvent[];

const put = (key: string, body: unknown) =>
  app.request(`/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  db = openDb(':memory:');
  seen = [];
  const events = new EventBus();
  events.subscribe((e) => seen.push(e));
  app = prefsRoutes({ db, events });
});

describe('writing one', () => {
  it('stores it and PUSHES the whole set', async () => {
    const res = await put('theme', { value: 'memphis' });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ prefs: { theme: 'memphis' } });
    expect(seen).toEqual([{ type: 'prefs.updated', prefs: { theme: 'memphis' } }]);
  });

  it('clears it with null — the ABSENCE of a row, not an empty string', async () => {
    // A client reads "no value" as "use your own default", so the two have to
    // stay tellable apart.
    await put('theme', { value: 'memphis' });
    const res = await put('theme', { value: null });
    expect((await res.json()) as unknown).toEqual({ prefs: {} });
    expect(new PrefStore(db).get('theme')).toBe(null);
  });

  it('refuses a key that is not a preference', async () => {
    // Without a whitelist this is an arbitrary broadcast channel with a
    // database behind it: anything could write anything, and every connected
    // browser would receive it.
    const res = await put('../../etc/passwd', { value: 'x' });
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('refuses a value too big to ride every push', async () => {
    const res = await put('theme', { value: 'x'.repeat(500) });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('refuses a body that is not a value', async () => {
    expect((await put('theme', { nope: 1 })).status).toBe(400);
    expect((await put('theme', {})).status).toBe(400);
  });
});

describe('reading them', () => {
  it('is an empty object before anything is set', async () => {
    const body = (await (await app.request('/')).json()) as { prefs: unknown };
    expect(body.prefs).toEqual({});
  });

  it('is never cached — a stale theme is a window wearing the wrong palette', async () => {
    expect((await app.request('/')).headers.get('cache-control')).toBe('no-store');
  });

  it('hides a key this build does not know, in or out', () => {
    // A row written by a newer build must not be served as if it were current.
    db.prepare('INSERT INTO app_prefs (key, value, updated_at) VALUES (?, ?, ?)').run(
      'from-the-future',
      'x',
      1,
    );
    expect(new PrefStore(db).all()).toEqual({});
  });

  it('answers at all on a database that predates the table', () => {
    // The prefs are then simply all default, which is what an empty object
    // means to every reader — not an error on the one request that paints.
    const bare = openDb(':memory:');
    bare.exec('DROP TABLE app_prefs');
    expect(new PrefStore(bare).all()).toEqual({});
    bare.close();
  });
});
