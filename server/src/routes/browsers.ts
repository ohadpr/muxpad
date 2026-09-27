import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import { type BrowserAppState, ensureBrowserApp, listBrowserApps } from '../browser/BrowserApps.js';
import { normalizeProfileName } from '../browser/BrowserProfile.js';
import { browserViewerLink, parseBrowserProxyPath } from '../browser/BrowserProxy.js';
import {
  BrowserAttention,
  BrowserWheel,
  type NeedsYou,
  type WheelLease,
} from '../browser/BrowserWheel.js';
import { findChrome } from '../browser/findChrome.js';

/**
 * REST for muxpad-owned browsers.
 *
 * Thin, like the apps routes: lifecycle lives in browser/BrowserApps.ts and the
 * mutual exclusion in browser/BrowserWheel.ts. What lives here is validation and
 * the one judgement a route is the right place for — WHO IS ASKING.
 *
 * THE ONE THING THIS FILE MUST NOT GET WRONG
 * ------------------------------------------
 * `holder` is not a free field. If a caller could put `holder: "human"` on a
 * request, every agent would simply say it was a person and the wheel would
 * mean nothing — the asymmetry that the whole feature rests on would be a
 * convention rather than a rule. So the routes are SPLIT by who may call them:
 *
 *   /wheel/take     always takes as a HUMAN. It is reached from the UI.
 *   /wheel/claim    always claims as an AGENT. It is reached from a tool.
 *
 * Neither accepts a holder. A tool calling the human route is a thing to fix in
 * the tool registration, not something to defend against with a flag the caller
 * supplies about itself.
 *
 * Routes:
 *   GET    /api/browsers                    → { browsers: BrowserView[] }
 *   POST   /api/browsers                    → BrowserView, 201   (ensure + start)
 *   GET    /api/browsers/:profile           → BrowserView
 *   POST   /api/browsers/:profile/wheel/take    → BrowserView  (human takes over)
 *   POST   /api/browsers/:profile/wheel/claim   → BrowserView | 409 (agent asks)
 *   POST   /api/browsers/:profile/wheel/renew   → BrowserView | 409
 *   DELETE /api/browsers/:profile/wheel         → BrowserView  (hand it back)
 *   POST   /api/browsers/:profile/needs-you     → BrowserView  (agent asks for a person)
 *   DELETE /api/browsers/:profile/needs-you     → BrowserView  (agent got past it)
 */

export interface BrowserView extends BrowserAppState {
  /** The host's loopback origin. Used by the proxy, not by a person. */
  localUrl: string;
  /** Who is driving, or null. */
  wheel: WheelLease | null;
  /** Set when an agent has asked for a person, and why. */
  needsYou: NeedsYou | null;
}

const TakeSchema = z.object({
  /** Pane or chat id — whatever identifies this specific claimant. */
  by: z.string().min(1).max(200),
  reason: z.string().max(400).optional(),
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000)
    .optional(),
});

const EnsureSchema = z.object({ profile: z.string().min(1).max(64) });

/** What the agent is stuck on, in words a person can act on. */
const NeedsYouSchema = z.object({ reason: z.string().min(1).max(400) });

/**
 * Builds a TakeRequest without undefined-valued keys.
 *
 * `exactOptionalPropertyTypes` is on, so spreading a parsed body — where an
 * absent `reason` is present-as-undefined — is a type error rather than a
 * harmless no-op. Worth keeping: it is the same setting that stops an absent
 * field from silently overwriting a real one.
 */
function takeRequest(
  data: { by: string; reason?: string | undefined; ttlMs?: number | undefined },
  holder: 'human' | 'agent',
) {
  return {
    holder,
    by: data.by,
    ...(data.reason !== undefined ? { reason: data.reason } : {}),
    ...(data.ttlMs !== undefined ? { ttlMs: data.ttlMs } : {}),
  };
}

/**
 * Passes a viewer request through to the host on loopback.
 *
 * Streaming rather than buffering: a screencast frame is ~50 KB and the viewer
 * page itself is the only thing here small enough to buffer without thinking
 * about it. `duplex: 'half'` is required by undici for a request with a body.
 */
export function browserProxyRoutes(deps: {
  db: Database.Database;
  fetchImpl?: typeof fetch;
}) {
  const app = new Hono();
  const doFetch = deps.fetchImpl ?? fetch;

  app.all('/*', async (c) => {
    const parsed = parseBrowserProxyPath(new URL(c.req.url).pathname);
    if (!parsed) return c.text('not found', 404);

    const state = listBrowserApps(deps.db).find((b) => b.profile === parsed.profile);
    if (!state) return c.text('no such browser', 404);
    // The row's url IS the viewer's loopback origin. Nothing else is trusted
    // here — the profile came off a URL and is only ever used as a lookup key.
    const target = `${state.viewerUrl}${parsed.rest}${new URL(c.req.url).search}`;

    try {
      const upstream = await doFetch(target, {
        method: c.req.method,
        headers: c.req.raw.headers,
        ...(c.req.method === 'GET' || c.req.method === 'HEAD'
          ? {}
          : { body: c.req.raw.body, duplex: 'half' }),
      } as RequestInit);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    } catch {
      // The browser is registered but its host is not up. Say so plainly — an
      // iframe showing a connection error reads as "muxpad is broken".
      return c.text('the browser is not running', 502);
    }
  });

  return app;
}

export function browsersRoutes(deps: {
  db: Database.Database;
  dataDir: string;
  hostEntry: string;
  cwd: string;
  registry: { start(appId: string): Promise<unknown>; stop(appId: string): Promise<unknown> };
  chromePath?: () => { path: string; source: string } | null;
  /** This machine's tailnet host, so the link works from a phone. */
  tailnetHost?: () => string | null;
}) {
  const app = new Hono();
  const wheel = new BrowserWheel(deps.db);
  const attention = new BrowserAttention(deps.db);
  const chromeFor = deps.chromePath ?? (() => findChrome());

  const view = (state: BrowserAppState): BrowserView => ({
    ...state,
    // What a PERSON is given: muxpad's own origin, tailnet when we know it, so
    // the link opens on a phone. The loopback url stays on `localUrl` because
    // the proxy still needs it — and because "which one do I dial" should not
    // be a judgement the client has to make.
    viewerUrl: browserViewerLink(state.profile, deps.tailnetHost?.() ?? null),
    localUrl: state.viewerUrl,
    wheel: wheel.holder(state.profile),
    needsYou: attention.get(state.profile),
  });

  const find = (profile: string): BrowserAppState | null =>
    listBrowserApps(deps.db).find((b) => b.profile === profile) ?? null;

  /** Normalizes and 400s on a bad name rather than letting it reach the filesystem. */
  const profileParam = (raw: string): string | null => {
    try {
      return normalizeProfileName(raw);
    } catch {
      return null;
    }
  };

  app.get('/', (c) => c.json({ browsers: listBrowserApps(deps.db).map(view) }));

  app.post('/', async (c) => {
    const parsed = EnsureSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'profile is required' }, 400);

    const profile = profileParam(parsed.data.profile);
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);

    // No browser is a configuration fact, not a crash — and the message names
    // the fix, because "failed to start browser" sends somebody reading logs
    // for twenty minutes.
    //
    // The message names the two SAFE answers and nothing else. It deliberately
    // does not mention the user's real Chrome, even to rule it out: an error
    // body is read as a to-do list, and "point it at /Applications" is exactly
    // the habit that put a TCC dialog on somebody's screen. The reason lives in
    // findChrome.ts, where the next person to edit discovery will read it.
    const chrome = chromeFor();
    if (!chrome) {
      return c.json(
        {
          error:
            'no browser muxpad can own — run `npx playwright install chromium`, or set MUXPAD_CHROME_BIN to a browser binary',
        },
        503,
      );
    }

    const state = await ensureBrowserApp(profile, {
      db: deps.db,
      dataDir: deps.dataDir,
      chromePath: chrome.path,
      hostEntry: deps.hostEntry,
      registry: deps.registry,
      cwd: deps.cwd,
    });
    return c.json(view(state), 201);
  });

  app.get('/:profile', (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const state = find(profile);
    return state ? c.json(view(state)) : c.json({ error: 'no such browser' }, 404);
  });

  /**
   * A PERSON takes the wheel. Always granted — that is the whole point; a human
   * outranks any agent, and an agent holding it is not a reason to refuse.
   */
  app.post('/:profile/wheel/take', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const state = find(profile);
    if (!state) return c.json({ error: 'no such browser' }, 404);

    const parsed = TakeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'by is required' }, 400);

    wheel.take(profile, takeRequest(parsed.data, 'human'));
    // Arriving IS the acknowledgement. An explicit ack nobody presses is how a
    // card ends up shouting after the thing was dealt with.
    attention.clear(profile);
    return c.json(view(state));
  });

  /** An AGENT asks. Refused with 409 while a person is driving. */
  app.post('/:profile/wheel/claim', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const state = find(profile);
    if (!state) return c.json({ error: 'no such browser' }, 404);

    const parsed = TakeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'by is required' }, 400);

    const result = wheel.take(profile, takeRequest(parsed.data, 'agent'));
    if (!result.granted) {
      // The reason is phrased for the agent to REPEAT rather than retry. 409 so
      // a client that only checks status still treats it as a refusal.
      return c.json({ ...view(state), error: result.reason }, 409);
    }
    return c.json(view(state));
  });

  /**
   * An agent asks for a person. It KEEPS the wheel — see BrowserAttention.
   */
  app.post('/:profile/needs-you', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const state = find(profile);
    if (!state) return c.json({ error: 'no such browser' }, 404);

    const parsed = NeedsYouSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'reason is required' }, 400);

    attention.raise(profile, parsed.data.reason);
    return c.json(view(state));
  });

  /** The agent got past it on its own; put the hand down. */
  app.delete('/:profile/needs-you', (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const state = find(profile);
    if (!state) return c.json({ error: 'no such browser' }, 404);
    attention.clear(profile);
    return c.json(view(state));
  });

  app.post('/:profile/wheel/renew', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const state = find(profile);
    if (!state) return c.json({ error: 'no such browser' }, 404);

    const parsed = TakeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'by is required' }, 400);

    const ok = parsed.data.ttlMs
      ? wheel.renew(profile, parsed.data.by, parsed.data.ttlMs)
      : wheel.renew(profile, parsed.data.by);
    return ok ? c.json(view(state)) : c.json({ ...view(state), error: 'not the holder' }, 409);
  });

  app.delete('/:profile/wheel', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const state = find(profile);
    if (!state) return c.json({ error: 'no such browser' }, 404);

    const parsed = TakeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'by is required' }, 400);

    wheel.release(profile, parsed.data.by);
    return c.json(view(state));
  });

  return app;
}
