import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import { type BrowserAppState, ensureBrowserApp, listBrowserApps } from '../browser/BrowserApps.js';
import { type BrowserEvent, BrowserEvents } from '../browser/BrowserEvents.js';
import { BrowserOwner } from '../browser/BrowserOwner.js';
import { browserJarPath, normalizeProfileName } from '../browser/BrowserProfile.js';
import { browserViewerLink, parseBrowserProxyPath } from '../browser/BrowserProxy.js';
import { browserShotPath, saveBrowserShot } from '../browser/BrowserShots.js';
import {
  BrowserAttention,
  BrowserWheel,
  type NeedsYou,
  type WheelLease,
} from '../browser/BrowserWheel.js';
import { type StorageState, mergeCookieChanges } from '../browser/CookieJar.js';
import {
  agentPaneForTab,
  nudgeForHandback,
  outstandingSummons,
} from '../browser/ResumeAfterHandback.js';
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
  /** The moments worth a card in a conversation, oldest first. */
  events: BrowserEvent[];
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

const EnsureSchema = z.object({
  profile: z.string().min(1).max(64),
  /** The chat this happened in, so its card lands in the right log. */
  tabId: z.string().min(1).max(64).optional(),
  /**
   * False registers the row and launches NOTHING.
   *
   * This is how an agent's session gets a browser without one existing: about
   * 200 MB of Chrome per session, for every session, most of which never browse.
   * The agent's wrapper registers and is handed a LAZY endpoint; the browser
   * starts the first time a tool actually reaches for it. See /:profile/cdp.
   */
  start: z.boolean().optional(),
});

/** What the agent is stuck on, in words a person can act on. */
const NeedsYouSchema = z.object({
  reason: z.string().min(1).max(400),
  tabId: z.string().min(1).max(64).optional(),
  /** What needs them, so the viewer can arrive pointing at it. */
  selector: z.string().min(1).max(200).optional(),
});

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
  /**
   * Starts the browser, because somebody asked to look at it.
   *
   * Browsers are lazy now, so "registered but not running" is the ordinary
   * state of one nobody has used for a while — and tapping its card used to
   * land on a bare "the browser is not running" 502, a dead end at the exact
   * moment somebody asked. Optional so the proxy still works standalone.
   */
  wake?: (profile: string) => Promise<boolean>;
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

    const pass = async () =>
      doFetch(target, {
        method: c.req.method,
        headers: c.req.raw.headers,
        ...(c.req.method === 'GET' || c.req.method === 'HEAD'
          ? {}
          : { body: c.req.raw.body, duplex: 'half' }),
      } as RequestInit);

    try {
      const upstream = await pass();
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    } catch {
      // Not up. ASK FOR IT rather than reporting a dead end: wanting to look at
      // a browser is a perfectly good reason to start one, and since browsers
      // became lazy this is the ordinary state of any that has been idle.
      // Only for a request that can afford the wait — a GET of the page itself.
      if (deps.wake && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
        try {
          if (await deps.wake(parsed.profile)) {
            const upstream = await pass();
            return new Response(upstream.body, {
              status: upstream.status,
              headers: upstream.headers,
            });
          }
        } catch {
          // Fall through to the honest answer below.
        }
      }
      // An iframe showing a connection error reads as "muxpad is broken", so
      // say what is true instead.
      return c.text('the browser is not running', 502);
    }
  });

  return app;
}

/**
 * Asks a host to write the shared jar.
 *
 * Fire-and-forget on purpose: it runs on the path where a person hands the
 * browser back, and that response must not wait on — or fail because of — a
 * cookie export. A jar that is one login stale is a much smaller problem than a
 * handoff that appears to hang.
 */
async function harvestJar(localUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${localUrl}/storage-state`).catch(() => undefined);
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
  /** This server's loopback address, so a host can announce its first page. */
  apiUrl?: string;
  /**
   * Wakes the conversation that asked for a person, when they hand the browser
   * back. Optional so the routes still stand up without a runner attached —
   * a missing relay means the handoff works exactly as it did before, which is
   * the right degradation for a convenience.
   */
  resumeAgent?: (paneId: string, text: string) => void;
}) {
  const app = new Hono();
  const wheel = new BrowserWheel(deps.db);
  const attention = new BrowserAttention(deps.db);
  const events = new BrowserEvents(deps.db);
  const owner = new BrowserOwner(deps.db);
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
    events: events.list(state.profile),
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

  /**
   * Photographs the page for a moment that is about to be recorded.
   *
   * Best-effort and BOUNDED: a browser that is slow, wedged or already gone must
   * not hold up the card that says so. Returns whether it landed, and the caller
   * records the moment either way.
   */
  const fetchShot = async (state: BrowserAppState): Promise<Uint8Array | null> => {
    try {
      // state.viewerUrl is the LOOPBACK host url here — view() renames it to
      // localUrl for the client, but this is the raw row.
      const res = await fetch(`${state.viewerUrl}/shot`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      return bytes.length ? bytes : null;
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
      ...(deps.apiUrl ? { apiUrl: deps.apiUrl } : {}),
      ...(parsed.data.start === false ? { start: false } : {}),
    });
    // NOT the moment for a card. This runs when the agent's MCP server starts,
    // which is before the person has typed anything — so an "opened" recorded
    // here is stamped earlier than the prompt that caused it and sorts above it,
    // every time, in every new chat. The conversation gets its card when a page
    // is actually visited; see POST /:profile/opened, which the host calls.
    //
    // The tab is remembered here because this is the only place that knows it.
    if (parsed.data.tabId) owner.set(profile, parsed.data.tabId);
    return c.json(view(state), 201);
  });

  /**
   * THE HOST SAYS A PAGE WAS ACTUALLY VISITED.
   *
   * This — not registration — is when a browser becomes a thing that happened
   * in a conversation. Called once per host process, on the first page that is
   * a page (a browser parked on its start screen has not been used), so a
   * session that never browses says nothing at all rather than announcing a
   * process nobody asked about.
   *
   * The tab comes from what registration remembered rather than from the
   * caller: the host has no idea which chat it belongs to, and a card scoped to
   * the wrong one is worse than no card.
   */
  app.post('/:profile/opened', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);

    // ONCE PER CONVERSATION, and the rule is about the chat rather than the
    // process. The host announces on its first page, so a host that RESTARTS
    // announces again — and it restarts for reasons that are nothing to do with
    // the person: a crash, a reap, a change to its command line. Seen in a real
    // chat: a summons at 17:37 and a bare "Browser opened" at 17:46, arriving
    // after the agent had already explained itself and saying nothing the
    // conversation did not already know.
    //
    // A summons counts as having said it. It is a louder statement of the same
    // fact — there is a browser here, and here is the way into it — so a card
    // repeating it quietly afterwards is noise with a button on it.
    const already = events.list(profile).some((e) => e.kind === 'opened' || e.kind === 'needs-you');
    if (already) return c.json({ ok: true, events: events.list(profile) }, 200);

    const tabId = owner.get(profile);
    // NO PICTURE HERE. A still taken now is the FIRST page the agent visited,
    // and the only card that would ever show it is the one for a browser that
    // has since closed — where the first page dressed as the last is a lie. The
    // browser photographs itself on the way out instead; see /:profile/closing.
    events.record(profile, {
      kind: 'opened',
      ...(tabId ? { tabId } : {}),
    });
    return c.json({ ok: true, events: events.list(profile) }, 201);
  });

  /**
   * THE LAZY CDP ENDPOINT — where a session browser actually starts.
   *
   * Every agent session used to launch a real Chrome, about 200 MB, when its
   * MCP server started: before the person had typed a word, and whether or not
   * that session would ever browse. Most never do. That is the memory complaint
   * this whole subsystem was built to answer, arriving from inside it.
   *
   * It works because playwright-mcp is lazy and we are not obliged to be eager.
   * Measured on the real thing: it advertises all 25 browser tools, answers
   * `initialize` and `tools/list`, and does not touch its `--cdp-endpoint`
   * until the first tool call — at which point it fetches `/json/version`. So
   * the wrapper registers the row without launching anything and hands
   * playwright THIS url. The first tool call lands here, the browser starts,
   * and the reply carries Chrome's own `webSocketDebuggerUrl`, which points at
   * loopback — so playwright talks to Chrome directly from then on and nothing
   * proxies the actual session.
   *
   * A catch-all rather than just `/json/version`, because what a client pokes
   * at a CDP endpoint is playwright's business and a 404 here reads as a broken
   * browser.
   */
  /**
   * The still for one moment, by its timestamp.
   *
   * CACHE, not record: a missing file is a 404 and the card simply draws without
   * a picture, which is what it did before these existed. Immutable once
   * written — the moment is in the past — so it is worth caching hard.
   */
  /**
   * THE LAST THING IT WAS LOOKING AT. Posted by the host on its way out.
   *
   * A still captured when the browser OPENED shows the first page it visited,
   * and putting that on the card for a closed browser presents the beginning as
   * the end — confidently wrong, which is worse than no picture at all. So the
   * browser photographs itself as it shuts down and the newest moment adopts it.
   *
   * Best-effort by nature: a browser that is killed rather than asked to stop
   * never gets here, and its card simply has no picture.
   */
  app.post('/:profile/closing', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    const moment = events.newestMoment(profile);
    if (!moment) return c.json({ ok: true, attached: false });
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!saveBrowserShot(deps.dataDir, profile, moment.at, bytes)) {
      return c.json({ ok: true, attached: false });
    }
    return c.json({ ok: true, attached: events.attachShot(profile, moment.at) });
  });

  app.get('/:profile/shot/:at', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    const at = Number(c.req.param('at'));
    if (!profile || !Number.isFinite(at)) return c.json({ error: 'no such still' }, 400);
    try {
      const bytes = await readFile(browserShotPath(deps.dataDir, profile, at));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return c.json({ error: 'no such still' }, 404);
    }
  });

  app.get('/:profile/cdp/*', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile) return c.json({ error: 'invalid profile name' }, 400);
    // chromeFor, not deps.chromePath: the dependency is optional and falls back
    // to discovery, which is how the POST route finds one. Reading the raw dep
    // here made this the only route that could not find a browser the rest of
    // the server was already using.
    const chrome = chromeFor();
    if (!chrome) return c.json({ error: 'no browser muxpad can own' }, 503);

    const state = await ensureBrowserApp(profile, {
      db: deps.db,
      dataDir: deps.dataDir,
      chromePath: chrome.path,
      hostEntry: deps.hostEntry,
      registry: deps.registry,
      cwd: deps.cwd,
      ...(deps.apiUrl ? { apiUrl: deps.apiUrl } : {}),
    });

    // Chrome takes a couple of seconds from cold. The agent's first tool call
    // waits for it, which is the whole bargain: a small pause the first time
    // something browses, instead of a browser for every session that never does.
    // The path AFTER this route's own prefix. Splitting on '/cdp' looks
    // equivalent and is not: a profile named `cdp` makes the first match the
    // wrong one, and the request is proxied to the root of the browser instead
    // of to /json/version. Anchored on the actual prefix instead.
    const prefix = `/api/browsers/${c.req.param('profile')}/cdp`;
    const path = new URL(c.req.url).pathname.slice(prefix.length) || '/';
    const upstream = `${state.cdpUrl}${path}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const res = await fetch(upstream);
        if (res.ok) {
          return new Response(await res.text(), {
            status: 200,
            headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
          });
        }
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        return c.json({ error: `browser for '${profile}' did not start` }, 504);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  // ONE writer for the shared jar: browser hosts submit deltas here instead of
  // racing full snapshots on disk. No await between read and atomic rename, so
  // requests in this server cannot interleave their read/modify/write.
  app.post('/:profile/cookies', async (c) => {
    const profile = profileParam(c.req.param('profile'));
    if (!profile || !find(profile)) return c.json({ error: 'no such browser' }, 404);
    const cookie = z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(['Strict', 'Lax', 'None']),
    });
    const state = z.object({ cookies: z.array(cookie), origins: z.array(z.unknown()) });
    const parsed = z
      .object({ seed: state, current: state })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid cookie export' }, 400);
    const path = browserJarPath(deps.dataDir);
    let jar: StorageState = { cookies: [], origins: [] };
    try {
      jar = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      // Do not overwrite a jar we could not read, except on the ordinary first run.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const merged = mergeCookieChanges(jar, parsed.data.seed, parsed.data.current);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.tmp', JSON.stringify(merged));
    renameSync(path + '.tmp', path);
    return c.json({ ok: true });
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
    // Arriving IS the acknowledgement, so the card stops SHOUTING here — but it
    // does not disappear here. While you hold the wheel that card is your way
    // back to the browser: navigate away on a phone and, without it, there is
    // nothing in the conversation to tap. It is retired on release instead.
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

    attention.raise(profile, parsed.data.reason, parsed.data.selector);
    // THE MOMENT MOST WORTH A PICTURE. "Amazon needs a login" is a claim you
    // have to take on trust and a tap to check; the same card showing the
    // sign-in page is the claim with its evidence attached.
    // TAKE THE PICTURE FIRST, NAME IT AFTERWARDS. `record` stamps its own `at`,
    // and the still is found by that number — so a timestamp taken out here is a
    // different one by however long the capture took (34ms, measured), and the
    // card points at a file that does not exist.
    const bytes = await fetchShot(state);
    const moment = events.record(profile, {
      kind: 'needs-you',
      reason: parsed.data.reason,
      ...(parsed.data.tabId ? { tabId: parsed.data.tabId } : {}),
      ...(bytes ? { shot: true } : {}),
    });
    if (bytes) saveBrowserShot(deps.dataDir, profile, moment.at, bytes);
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

    const held = wheel.holder(profile);
    // BEFORE the `resolved` below, which is the thing that closes it.
    const waiting = outstandingSummons(events.list(profile));
    const released = wheel.release(profile, parsed.data.by);
    // Handed back: the errand is over, so the card retires. Only for the person
    // who actually held it — a failed release must not retire somebody's card.
    if (held?.by === parsed.data.by && held.holder === 'human') {
      events.record(profile, { kind: 'resolved' });
    }
    // AND THE AGENT IS TOLD, because it is the only party that does not already
    // know. Pressing Done used to hand the browser back and leave the person to
    // go and say so in words — two taps and a sentence to deliver a fact muxpad
    // had the instant the wheel came back. See ResumeAfterHandback for every
    // case where this deliberately stays quiet.
    const tabId = owner.get(profile);
    const nudge = nudgeForHandback({
      held: held ? { holder: held.holder, by: held.by } : null,
      by: parsed.data.by,
      needsYou: waiting,
      paneId: tabId ? agentPaneForTab(deps.db, tabId) : null,
    });
    if (nudge) deps.resumeAgent?.(nudge.paneId, nudge.text);
    // A person has just finished with the browser, which is overwhelmingly when
    // a LOGIN has just happened. Harvest it into the shared jar now, so the next
    // session starts warm — otherwise the login only ever reaches whoever
    // happens to call /storage-state later, which is nobody.
    if (released && held?.holder === 'human') void harvestJar(state.viewerUrl).catch(() => {});
    return c.json(view(state));
  });

  return app;
}
