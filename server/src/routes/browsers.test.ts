import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

let tempDataDir: string;
let resumed: Array<{ paneId: string; text: string }>;
const resumeAgent = (paneId: string, text: string) => {
  resumed.push({ paneId, text });
};

beforeEach(() => {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith('/agent-quiesce') || url.endsWith('/handoff'))
      return Promise.resolve(new Response('{}'));
    return realFetch(input, init);
  });
  tempDataDir = mkdtempSync(join(tmpdir(), 'browsers-route-'));
  resumed = [];
  db = new Database(':memory:');
  db.exec(`CREATE TABLE apps (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    cwd TEXT NOT NULL, command TEXT NOT NULL, url TEXT NOT NULL,
    autostart INTEGER NOT NULL, enabled INTEGER NOT NULL, pane_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE globals (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE panes (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL,
                        kind TEXT NOT NULL DEFAULT 'shell',
                        created_at INTEGER NOT NULL);`);
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
      // A REAL directory: the routes that store a card's picture actually write
      // one, and '/data' silently fails every write — which reads as "the
      // feature does not work" when it is the fixture that does not.
      dataDir: tempDataDir,
      hostEntry: '/opt/cli.js',
      cwd: '/home',
      registry,
      chromePath: () => CHROME,
      tailnetHost: () => 'example-host.example-tailnet.ts.net',
      resumeAgent,
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDataDir, { recursive: true, force: true });
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

async function ensure(opts: { profile?: string; tabId?: string } | string = 'shopping') {
  const { profile = 'shopping', tabId } =
    typeof opts === 'string' ? { profile: opts, tabId: undefined } : opts;
  const res = await post('/api/browsers', { profile, ...(tabId ? { tabId } : {}) });
  expect(res.status).toBe(201);
  return res.json();
}

const get = (path: string) => app.request(path);

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
    expect(body.viewerUrl).toBe('https://example-host.example-tailnet.ts.net/browser/shopping/');
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
    await post('/api/browsers/shopping/opened', {});
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    const res = await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    expect(((await res.json()) as { needsYou: unknown }).needsYou).toBeNull();
  });

  it('can be withdrawn when the agent gets past it alone', async () => {
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    const res = await del('/api/browsers/shopping/needs-you');
    expect(((await res.json()) as { needsYou: unknown }).needsYou).toBeNull();
  });

  it('400s an ask with no reason — a card that says nothing is not actionable', async () => {
    await ensure();
    expect((await post('/api/browsers/shopping/needs-you', {})).status).toBe(400);
  });
});

describe('a browser starts when something reaches for it, not before', () => {
  /**
   * Every agent session used to launch a real Chrome when its MCP server
   * started — before the person had typed, and whether or not that session
   * would ever browse. Most never do. Ninety-seven of them accumulated on one
   * machine, which is the memory complaint this subsystem exists to answer,
   * arriving from inside it.
   */
  /** A stand-in for Chrome's HTTP side, on the port this profile was given. */
  async function fakeChromeOn(cdpUrl: string) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/abc' }));
    });
    await new Promise<void>((r) => server.listen(Number(new URL(cdpUrl).port), '127.0.0.1', r));
    return () => new Promise<void>((r) => server.close(() => r()));
  }

  it('registers a row without launching anything', async () => {
    const res = await post('/api/browsers', { profile: 'shopping', start: false });
    expect(res.status).toBe(201);
    expect(registry.start).not.toHaveBeenCalled();
  });

  it('starts it when the CDP endpoint is first asked for', async () => {
    // This is the first browser tool call arriving. playwright-mcp does not
    // touch its --cdp-endpoint until then, which is the measured fact the whole
    // arrangement rests on.
    const body = (await (
      await post('/api/browsers', { profile: 'shopping', start: false })
    ).json()) as { cdpUrl: string };
    const close = await fakeChromeOn(body.cdpUrl);
    try {
      const res = await app.request('/api/browsers/shopping/cdp/json/version');
      expect(registry.start).toHaveBeenCalledTimes(1);
      // Discovery must never hand out the unguarded Chrome socket.
      expect(res.status).toBe(200);
      expect((await res.json()) as { webSocketDebuggerUrl: string }).toMatchObject({
        webSocketDebuggerUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/agent-cdp$/),
      });
    } finally {
      await close();
    }
  });

  it('proxies the exact path, even for a profile called "cdp"', async () => {
    // Splitting the url on '/cdp' looks equivalent to trimming the prefix and
    // is not: this profile makes the first match the wrong one, and the request
    // lands on the browser's root instead of /json/version.
    const body = (await (await post('/api/browsers', { profile: 'cdp', start: false })).json()) as {
      cdpUrl: string;
    };
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"webSocketDebuggerUrl":"ws://127.0.0.1:1/x"}');
    });
    await new Promise<void>((r) =>
      server.listen(Number(new URL(body.cdpUrl).port), '127.0.0.1', r),
    );
    try {
      await app.request('/api/browsers/cdp/cdp/json/version');
      expect(asked).toEqual(['/json/version']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refuses a profile name that is not one', async () => {
    const res = await app.request('/api/browsers/..%2Fetc/cdp/json/version');
    expect(res.status).toBe(400);
  });
});

describe('the moments a conversation shows', () => {
  it('records the summons as its own moment, with the reason', async () => {
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    const res = await post('/api/browsers/shopping/needs-you', {
      reason: 'log in to Amazon',
      tabId: 'tab-1',
    });
    const body = (await res.json()) as { events: Array<{ kind: string; reason?: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you']);
    expect(body.events[1]).toMatchObject({ reason: 'log in to Amazon', tabId: 'tab-1' });
  });

  it('says NOTHING when a browser is merely provisioned', async () => {
    // Provisioning happens as the agent's MCP server starts — before the person
    // has typed anything. A card recorded there is stamped earlier than the
    // prompt that caused it and sorts above it, in every new chat, and it
    // announces a process rather than an event: a session that never browses
    // used to get a card about a browser nobody used.
    await ensure();
    const res = await get('/api/browsers/shopping');
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events).toEqual([]);
  });

  it('records it when the host says a page was actually visited', async () => {
    await ensure();
    const res = await post('/api/browsers/shopping/opened', {});
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened']);
  });

  it('puts that card in the chat the browser was registered for', async () => {
    // The host has no idea which conversation it belongs to, and the profile
    // name cannot answer it either: a profile is a LOWERCASED slug of the tab
    // id, and a card is shown only where the id matches exactly.
    await ensure({ tabId: '01KRG3EMB8F6NFHXZH40HNKZGK' });
    const res = await post('/api/browsers/shopping/opened', {});
    const body = (await res.json()) as { events: Array<{ tabId?: string }> };
    expect(body.events[0]?.tabId).toBe('01KRG3EMB8F6NFHXZH40HNKZGK');
  });

  it('names the still by the MOMENT it belongs to, not by a clock read nearby', async () => {
    // Caught live, not in a unit test: `record` stamps its own `at`, and the
    // still is found by that number — so a timestamp taken before the capture is
    // a different one by however long the capture took (34ms, measured), and the
    // card points at a file that does not exist. The event and the file have to
    // agree, so the fetch happens first and the SAVE is named afterwards.
    await ensure();
    const res = await post('/api/browsers/shopping/opened', {});
    const body = (await res.json()) as { events: Array<{ at: number; shot?: boolean }> };
    const moment = body.events.at(-1);
    if (moment?.shot) {
      const still = await app.request(`/api/browsers/shopping/shot/${moment.at}`);
      expect(still.status).toBe(200);
    }
    // With no host answering there is no picture, and the card must not claim
    // one — which is the other half of the same contract.
    expect(moment?.shot ?? false).toBe(false);
  });

  it('says it ONCE, however many times the host restarts', async () => {
    // The host announces on its first page, so a restart announces again — and
    // it restarts for reasons nothing to do with the person: a crash, a reap, a
    // change to its command line.
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    const res = await post('/api/browsers/shopping/opened', {});
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened']);
  });

  it('and not at all once the chat has been summoned', async () => {
    // Seen in a real chat: a summons, then a bare "Browser opened" nine minutes
    // later, arriving after the agent had already explained itself. A summons
    // is a louder statement of the same fact — there is a browser here, and
    // here is the way in — so repeating it quietly afterwards is noise with a
    // button on it.
    await ensure();
    await post('/api/browsers/shopping/needs-you', { reason: 'log in' });
    await post('/api/browsers/shopping/opened', {});
    const res = await get('/api/browsers/shopping');
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['needs-you']);
  });

  it('does NOT retire the card when you take the wheel', async () => {
    // While you hold the browser that card is the way BACK to it. Navigate away
    // on a phone and, if it has gone, there is nothing left in the conversation
    // to tap.
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    const res = await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you']);
  });

  it('retires it when you hand the browser back', async () => {
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await del('/api/browsers/shopping/wheel', { by: 'pane-7' });
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you', 'resolved']);
  });

  it('does not retire it for somebody who was not holding it', async () => {
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    await post('/api/browsers/shopping/needs-you', { reason: 'captcha' });
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await del('/api/browsers/shopping/wheel', { by: 'someone-else' });
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['opened', 'needs-you']);
  });

  it('does not record a "resolved" when nothing was asking', async () => {
    await ensure();
    await post('/api/browsers/shopping/opened', {});
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

describe('the last picture, and serving it back', () => {
  /**
   * Both of these were written tonight and checked only by hand against a live
   * browser. An audit of which routes nothing had ever called found them.
   */
  it('attaches a still to the newest moment', async () => {
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    const res = await app.request('/api/browsers/shopping/closing', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { attached: boolean }).toMatchObject({ attached: true });
    const view = (await (await get('/api/browsers/shopping')).json()) as {
      events: Array<{ at: number; shot?: boolean }>;
    };
    expect(view.events.at(-1)?.shot).toBe(true);
  });

  it('serves that still back at the moment it belongs to', async () => {
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    await app.request('/api/browsers/shopping/closing', {
      method: 'POST',
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]),
    });
    const view = (await (await get('/api/browsers/shopping')).json()) as {
      events: Array<{ at: number }>;
    };
    const at = view.events.at(-1)?.at;
    const still = await app.request(`/api/browsers/shopping/shot/${at}`);
    expect(still.status).toBe(200);
    expect(still.headers.get('content-type')).toBe('image/jpeg');
  });

  it('404s for a moment with no picture, rather than half-serving one', async () => {
    // The card draws without it. A broken image reads as a fault.
    await ensure();
    expect((await app.request('/api/browsers/shopping/shot/12345')).status).toBe(404);
  });

  it('refuses a still request that is not a moment', async () => {
    await ensure();
    expect((await app.request('/api/browsers/shopping/shot/not-a-time')).status).toBe(400);
  });

  it('says so when there is no moment to attach one to', async () => {
    // A browser that has never been used has nothing to illustrate.
    await ensure();
    const res = await app.request('/api/browsers/shopping/closing', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    });
    expect((await res.json()) as { attached: boolean }).toMatchObject({ attached: false });
  });

  it('does not claim to have attached an EMPTY picture', async () => {
    // A zero-byte file renders as a hole, which is worse than no picture.
    await ensure();
    await post('/api/browsers/shopping/opened', {});
    const res = await app.request('/api/browsers/shopping/closing', {
      method: 'POST',
      body: new Uint8Array([]),
    });
    expect((await res.json()) as { attached: boolean }).toMatchObject({ attached: false });
  });
});

describe('keeping a lease alive', () => {
  it('renews for the person holding it', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await post('/api/browsers/shopping/wheel/renew', { by: 'pane-7' });
    expect(res.status).toBe(200);
  });

  it('refuses anybody else, so an open tab cannot extend a stranger’s hold', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
    const res = await post('/api/browsers/shopping/wheel/renew', { by: 'someone-else' });
    expect(res.status).toBe(409);
  });

  it('refuses when nobody holds it at all', async () => {
    await ensure();
    expect((await post('/api/browsers/shopping/wheel/renew', { by: 'pane-7' })).status).toBe(409);
  });

  it('pushes the expiry out, which is the whole point', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'pane-7', ttlMs: 1000 });
    const before = (await (await get('/api/browsers/shopping')).json()) as {
      wheel: { expiresAt: number };
    };
    await post('/api/browsers/shopping/wheel/renew', { by: 'pane-7', ttlMs: 60_000 });
    const after = (await (await get('/api/browsers/shopping')).json()) as {
      wheel: { expiresAt: number };
    };
    expect(after.wheel.expiresAt).toBeGreaterThan(before.wheel.expiresAt);
  });
});

describe('handing the browser back wakes the agent that asked', () => {
  /**
   * The handoff was only ever built one way round. The agent raised a card and
   * stopped — correctly, because a turn spent polling while somebody walks to
   * their phone is a turn spent burning tokens on waiting. But the return leg
   * did not exist: the person signed in, pressed Done, and then had to go and
   * TELL the agent in words that they had finished. Two taps and a sentence to
   * deliver a fact muxpad had the moment the wheel came back.
   */
  const handoff = async (opts: { pane?: boolean } = {}) => {
    await ensure({ profile: 'shopping', tabId: 'TAB1' });
    if (opts.pane !== false) {
      db.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('pane-9', 'TAB1', 'agent', 1);
    }
    await post('/api/browsers/shopping/needs-you', { reason: 'Amazon needs a login' });
    await post('/api/browsers/shopping/wheel/take', { by: 'viewer-shopping' });
  };

  it('tells the conversation, naming what it had asked for', async () => {
    await handoff();
    await del('/api/browsers/shopping/wheel', { by: 'viewer-shopping' });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.paneId).toBe('pane-9');
    expect(resumed[0]?.text).toContain('Amazon needs a login');
  });

  it('puts the hand down, so the card stops asking for somebody who has been', async () => {
    await handoff();
    await del('/api/browsers/shopping/wheel', { by: 'viewer-shopping' });
    const view = await (await get('/api/browsers/shopping')).json();
    expect(view.needsYou).toBeNull();
  });

  it('says nothing when nobody was asked for', async () => {
    // Somebody took the wheel to look at something. They interrupted nothing.
    await ensure({ profile: 'shopping', tabId: 'TAB1' });
    db.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('pane-9', 'TAB1', 'agent', 1);
    await post('/api/browsers/shopping/wheel/take', { by: 'viewer-shopping' });
    await del('/api/browsers/shopping/wheel', { by: 'viewer-shopping' });
    expect(resumed).toEqual([]);
  });

  it('says nothing when an agent releases its own wheel', async () => {
    // It is the thing being told. Telling it would be a loop.
    await ensure({ profile: 'shopping', tabId: 'TAB1' });
    db.prepare('INSERT INTO panes VALUES (?,?,?,?)').run('pane-9', 'TAB1', 'agent', 1);
    await post('/api/browsers/shopping/needs-you', { reason: 'a login' });
    await post('/api/browsers/shopping/wheel/claim', { by: 'pane-9' });
    await del('/api/browsers/shopping/wheel', { by: 'pane-9' });
    expect(resumed).toEqual([]);
  });

  it('says nothing twice, however many times Done is pressed', async () => {
    // The button is reachable after the lease is already gone, and a second
    // message would read as a second handoff.
    await handoff();
    await del('/api/browsers/shopping/wheel', { by: 'viewer-shopping' });
    await del('/api/browsers/shopping/wheel', { by: 'viewer-shopping' });
    expect(resumed).toHaveLength(1);
  });

  it('hands back fine when the conversation has no pane left', async () => {
    // A chat whose pane is gone. The release must still work — the browser
    // coming back is the important half.
    await handoff({ pane: false });
    const res = await del('/api/browsers/shopping/wheel', { by: 'viewer-shopping' });
    expect(res.status).toBe(200);
    expect(resumed).toEqual([]);
  });
});

describe('cookie exports from independently seeded browsers', () => {
  const cookie = (name: string, value = 'login') => ({
    name,
    value,
    domain: 'example.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
  const state = (cookies: unknown[]) => ({ cookies, origins: [] });
  it('preserves another session login when an older empty snapshot arrives', async () => {
    await ensure();
    const exportState = (seed: unknown[], current: unknown[]) =>
      post('/api/browsers/shopping/cookies', {
        seed: state(seed),
        current: state(current),
      });
    expect((await exportState([], [cookie('new-login')])).status).toBe(200);
    expect((await exportState([], [])).status).toBe(200);
    const jar = JSON.parse(
      readFileSync(join(tempDataDir, 'browser-profiles/shared.cookies.json'), 'utf8'),
    );
    expect(jar.cookies).toEqual([cookie('new-login')]);
    // An unchanged stale cookie must not roll back a refreshed login either.
    await exportState([cookie('new-login')], [cookie('new-login', 'fresh')]);
    await exportState([cookie('new-login')], [cookie('new-login')]);
    expect(
      JSON.parse(readFileSync(join(tempDataDir, 'browser-profiles/shared.cookies.json'), 'utf8'))
        .cookies,
    ).toEqual([cookie('new-login', 'fresh')]);
    // Logging out of the stale session cannot delete that refreshed login.
    await exportState([cookie('new-login')], []);
    expect(
      JSON.parse(readFileSync(join(tempDataDir, 'browser-profiles/shared.cookies.json'), 'utf8'))
        .cookies,
    ).toEqual([cookie('new-login', 'fresh')]);
    // A logout of the current session does remove its own unchanged login.
    await exportState([cookie('new-login', 'fresh')], []);
    expect(
      JSON.parse(readFileSync(join(tempDataDir, 'browser-profiles/shared.cookies.json'), 'utf8'))
        .cookies,
    ).toEqual([]);
  });

  it('does not harvest a watch-only close or a rejected release', async () => {
    await ensure();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      await del('/api/browsers/shopping/wheel', { by: 'watcher' });
      await post('/api/browsers/shopping/wheel/take', { by: 'holder' });
      await del('/api/browsers/shopping/wheel', { by: 'watcher' });
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/storage-state'))).toBe(
        false,
      );
    } finally {
      fetcher.mockRestore();
    }
  });
});

it('refuses an agent claim even when the human took the wheel under the same pane ID', async () => {
  await ensure();
  await post('/api/browsers/shopping/wheel/take', { by: 'pane-7' });
  const claim = await post('/api/browsers/shopping/wheel/claim', { by: 'pane-7' });
  expect(claim.status).toBe(409);
  expect((await claim.json()).wheel.holder).toBe('human');
});

describe('enforced browser handoffs', () => {
  it('refuses CDP discovery during a human lease', async () => {
    await ensure();
    await post('/api/browsers/shopping/wheel/take', { by: 'person' });
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/direct' })),
    );
    const response = await get('/api/browsers/shopping/cdp/json/version');
    expect(response.status).toBe(409);
  });

  it('does not acknowledge takeover while a forwarded command is still running', async () => {
    await ensure();
    vi.mocked(fetch).mockResolvedValue(new Response('busy', { status: 503 }));
    const response = await post('/api/browsers/shopping/wheel/take', { by: 'person' });
    expect(response.status).toBe(503);
    expect((await (await get('/api/browsers/shopping')).json()).wheel.holder).toBe('human');
  });

  it('binds the requested target before photographing and recording the summons', async () => {
    await ensure();
    const response = await post('/api/browsers/shopping/needs-you', {
      reason: 'Login',
      targetId: 'page-B',
    });
    expect(response.status).toBe(200);
    const calls = vi.mocked(fetch).mock.calls;
    const binding = calls.findIndex(([url]) => String(url).endsWith('/handoff'));
    const shot = calls.findIndex(([url]) => String(url).endsWith('/shot'));
    expect(binding).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(String(calls[binding]?.[1]?.body))).toEqual({ targetId: 'page-B' });
    expect(shot).toBeGreaterThan(binding);
  });

  it('does not summon a person if the host cannot identify the handoff page', async () => {
    await ensure();
    vi.mocked(fetch).mockResolvedValue(new Response('ambiguous', { status: 409 }));
    const response = await post('/api/browsers/shopping/needs-you', { reason: 'Login' });
    expect(response.status).toBe(409);
    const state = await (await get('/api/browsers/shopping')).json();
    expect(state.needsYou).toBeNull();
    expect(state.events).toEqual([]);
  });
});

it('cannot retarget the human viewer through needs-you while a human is typing', async () => {
  await ensure();
  await post('/api/browsers/shopping/wheel/take', { by: 'person' });
  vi.mocked(fetch).mockClear();
  const response = await post('/api/browsers/shopping/needs-you', {
    reason: 'Login elsewhere',
    targetId: 'page-B',
  });
  expect(response.status).toBe(409);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/handoff'))).toBe(false);
});
