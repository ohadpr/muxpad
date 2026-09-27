import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browsersRoutes } from './browsers.js';

/**
 * The REST surface, and the one thing it must not get wrong.
 *
 * `holder` is not a field a caller supplies. If it were, an agent would simply
 * claim to be a person and the asymmetry the whole feature rests on would be a
 * convention rather than a rule. The routes are split by WHO MAY CALL THEM:
 * /wheel/take is the UI and is always human, /wheel/claim is a tool and is
 * always agent. These tests exist mostly to pin that.
 */

let db: Database.Database;
let app: Hono;
let registry: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

const CHROME = { path: '/bin/chrome', source: 'test' };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE apps (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    cwd TEXT NOT NULL, command TEXT NOT NULL, url TEXT NOT NULL,
    autostart INTEGER NOT NULL, enabled INTEGER NOT NULL, pane_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE globals (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  // The real AppRegistry.start ENABLES the row; a fake that does not model
  // that makes every ensure() look like a fresh launch, which is exactly the
  // signal the "opened" event is keyed on.
  registry = {
    start: vi.fn(async (id: string) => {
      db.prepare('UPDATE apps SET enabled = 1 WHERE id = ?').run(id);
    }),
    stop: vi.fn(async (id: string) => {
      db.prepare('UPDATE apps SET enabled = 0 WHERE id = ?').run(id);
    }),
  };
  app = new Hono().route(
    '/api/browsers',
    browsersRoutes({
      db,
      dataDir: '/data',
      hostEntry: '/opt/cli.js',
      cwd: '/home',
      registry,
      chromePath: () => CHROME,
      tailnetHost: () => 'dt-mac-mini.example-tailnet.ts.net',
    }),
  );
});

const post = (path: string, body: unknown = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const del = (path: string, body: unknown = {}) =>
  app.request(path, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function ensure(profile = 'shopping') {
  const res = await post('/api/browsers', { profile });
  expect(res.status).toBe(201);
  return res.json();
}

describe('creating', () => {
  it('hands a person a link on muxpad’s own origin, not a loopback port', async () => {
    // A loopback url is useless on the phone the handoff is FOR. The viewer is
    // proxied under muxpad, so the link inherits the cockpit's reachability.
    const body = (await ensure()) as {
      profile: string;
      viewerUrl: string;
      localUrl: string;
      cdpUrl: string;
    };
    expect(body.profile).toBe('shopping');
    expect(body.viewerUrl).toBe('https://dt-mac-mini.example-tailnet.ts.net/browser/shopping/');
    // The loopback origin is still reported, because the proxy needs it — but
    // it is not the thing a person is handed.
    expect(body.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(body.cdpUrl).not.toBe(body.localUrl);
  });

  it('falls back to the cockpit origin when there is no tailnet name', async () => {
    const noTailnet = new Hono().route(
      '/api/browsers',
      browsersRoutes({
        db,
        dataDir: '/data',
        hostEntry: '/opt/cli.js',
        cwd: '/home',
        registry,
        chromePath: () => CHROME,
        tailnetHost: () => null,
      }),
    );
    const res = await noTailnet.request('/api/browsers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'shopping' }),
    });
    expect(((await res.json()) as { viewerUrl: string }).viewerUrl).toContain('/browser/shopping/');
  });

  it('is idempotent over the wire too', async () => {
    await ensure();
    await ensure();
    const res = await app.request('/api/browsers');
    expect(((await res.json()) as { browsers: unknown[] }).browsers).toHaveLength(1);
  });

  it('400s a profile name that would escape the data dir', async () => {
    const res = await post('/api/browsers', { profile: '../../etc' });
    expect(res.status).toBe(400);
  });

  it('503s with a message that names the fix when there is no Chrome', async () => {
    // "failed to start browser" sends somebody reading logs for twenty minutes.
    const noChrome = new Hono().route(
      '/api/browsers',
      browsersRoutes({
        db,
        dataDir: '/data',
        hostEntry: '/opt/cli.js',
        cwd: '/home',
        registry,
        chromePath: () => null,
      }),
    );
    const res = await noChrome.request('/api/browsers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'shopping' }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /MUXPAD_CHROME_BIN|playwright install/,
    );
  });

  it('never tells anyone to go find their real Chrome', async () => {
    // The message is the last place a "just point it at /Applications" habit
    // could creep back in. See findChrome.ts for why that is forbidden.
    const noChrome = new Hono().route(
      '/api/browsers',
      browsersRoutes({
        db,
        dataDir: '/data',
        hostEntry: '/opt/cli.js',
        cwd: '/home',
        registry,
        chromePath: () => null,
      }),
    );
    const res = await noChrome.request('/api/browsers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'shopping' }),
    });
    expect(((await res.json()) as { error: string }).error).not.toContain('/Applications');
  });

  it('404s a browser that was never registered', async () => {
    expect((await app.request('/api/browsers/nope')).status).toBe(404);
  });
});

describe('the wheel over HTTP', () => {
  it('lets a person take it', async () => {
    await ensure();
    const res = await post('/api/browsers/shopping/wheel/take', {
      by: 'pane-7',
      reason: 'captcha',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { wheel: unknown }).wheel).toMatchObject({
      holder: 'human',
      by: 'pane-7',
    });
  });

  it('REFUSES an agent while a person is driving, with 409 and a reason', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await post('/api/browsers/shopping/wheel/claim', { by: 'chat-1' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/human/i);
  });

  it('lets a person take it FROM an agent', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/claim', { by: 'chat-1' });
    const res = await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { wheel: { holder: string } }).wheel.holder).toBe('human');
  });

  it('gives an agent no way to CLAIM to be a person', async () => {
    // The route decides the holder, not the caller. If this ever reads a
    // `holder` off the body, the asymmetry stops being a rule.
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await post('/api/browsers/shopping/wheel/claim', {
      by: 'chat-1',
      holder: 'human',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { wheel: { by: string } };
    expect(body.wheel.by).toBe('pane-7');
  });

  it('hands it back, and only for the holder', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const wrong = await del('/api/browsers/shopping/wheel', { by: 'chat-1' });
    expect(((await wrong.json()) as { wheel: unknown }).wheel).not.toBeNull();
    const right = await del('/api/browsers/shopping/wheel', { by: 'pane-7' });
    expect(((await right.json()) as { wheel: unknown }).wheel).toBeNull();
  });

  it('409s a renew from somebody who is not holding it', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await post('/api/browsers/shopping/wheel/renew', { by: 'chat-1' });
    expect(res.status).toBe(409);
  });

  it('400s a wheel request with no claimant', async () => {
    await ensure();
    expect((await post('/api/browsers/shopping/wheel/take', {})).status).toBe(400);
  });

  it('keeps wheels separate per profile', async () => {
    await ensure('shopping');
    await ensure('research');
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await app.request('/api/browsers/research');
    expect(((await res.json()) as { wheel: unknown }).wheel).toBeNull();
  });
});

describe('asking for a person', () => {
  it('raises the flag while the agent KEEPS the wheel', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/claim', { by: 'chat-1' });
    const res = await post('/api/browsers/shopping/needs-you', { reason: 'log in to Amazon' });
    const body = (await res.json()) as { needsYou: { reason: string }; wheel: { holder: string } };
    expect(body.needsYou.reason).toBe('log in to Amazon');
    expect(body.wheel.holder).toBe('agent');
  });

  it('is LOWERED by a person taking the wheel, with no separate ack', async () => {
    // An ack nobody presses is how a card ends up shouting after the thing was
    // already dealt with.
    await ensure();
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    const res = await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    expect(((await res.json()) as { needsYou: unknown }).needsYou).toBeNull();
  });

  it('can be withdrawn when the agent gets past it alone', async () => {
    await ensure();
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    const res = await del('/api/browsers/shopping/needs-you');
    expect(((await res.json()) as { needsYou: unknown }).needsYou).toBeNull();
  });

  it('400s an ask with no reason — a card that says nothing is not actionable', async () => {
    await ensure();
    expect((await post('/api/browsers/shopping/needs-you', {})).status).toBe(400);
  });
});

describe('the moments a conversation shows', () => {
  it('records an "opened" when the browser actually starts', async () => {
    const res = await post('/api/browsers', { profile: 'shopping', tabId: 'tab-1' });
    const body = (await res.json()) as { events: Array<{ kind: string; tabId?: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: 'opened', tabId: 'tab-1' });
  });

  it('does NOT record one for a browser that is already running', async () => {
    // POST is idempotent, and the UI polls. An "opened" card per poll would
    // bury the conversation it is supposed to sit inside.
    await ensure();
    await post('/api/browsers', { profile: 'shopping' });
    await post('/api/browsers', { profile: 'shopping' });
    const res = await app.request('/api/browsers/shopping');
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it('records the summons as its own moment, with the reason', async () => {
    await ensure();
    const res = await post('/api/browsers/shopping/needs-you', {
      reason: 'log in to Amazon',
      tabId: 'tab-1',
    });
    const body = (await res.json()) as { events: Array<{ kind: string; reason?: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you']);
    expect(body.events[1]).toMatchObject({ reason: 'log in to Amazon', tabId: 'tab-1' });
  });

  it('does NOT retire the card when you take the wheel', async () => {
    // While you hold the browser that card is the way BACK to it. Navigate away
    // on a phone and, if it has gone, there is nothing left in the conversation
    // to tap.
    await ensure();
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    const res = await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you']);
  });

  it('retires it when you hand the browser back', async () => {
    await ensure();
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await del('/api/browsers/shopping/wheel', { by: 'pane-7' });
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you', 'resolved']);
  });

  it('does not retire it for somebody who was not holding it', async () => {
    await ensure();
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await del('/api/browsers/shopping/wheel', { by: 'someone-else' });
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you']);
  });

  it('does not record a "resolved" when nothing was asking', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await del('/api/browsers/shopping/wheel', { by: 'pane-7' });
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'resolved']);
  });
});

describe('harvesting the jar', () => {
  it('exports after a person hands the browser back', async () => {
    // That moment is overwhelmingly "a login just happened". Without this the
    // login reaches the jar only if somebody calls /storage-state later, which
    // is nobody, and the next session starts cold.
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    try {
      await ensure();
      await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
      await del('/api/browsers/shopping/wheel', { by: 'pane-7' });
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.some((u) => u.endsWith('/storage-state'))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
