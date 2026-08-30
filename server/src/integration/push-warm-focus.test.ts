// "Push notifications work, but tapping them almost never takes me to the pane
// that needs me."
//
// The cold path (no window open → openWindow with the deep link) was never the
// problem: the URL carries the target. The broken one is the WARM path — the
// PWA is already open, somewhere else, and a notificationclick focuses the
// existing window, which comes forward showing exactly what it was showing
// before. Nothing about that is reproducible in a unit test: it needs a real
// service worker, a real page, real Cache Storage and a real router.
//
// So: a real isolated muxpad (own port, own data dir, own ptyd socket), the
// real built web bundle, real Chromium, and the real sw.js dispatching a real
// notificationclick. Three deliveries, all of which had to work:
//
//   1. WARM     the SW postMessages a live page sitting on ANOTHER TAB.
//   2. PRE-BOOT the target is in Cache Storage before the page loads, so it is
//               drained BEFORE React has committed the router — the window in
//               which a naive router.navigate() silently does nothing.
//   3. SLOW     the target arrives while the workspace list is still in flight.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type Database from 'better-sqlite3';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { mountStaticWeb } from '../static-assets.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist');

/*
 * The callbacks handed to `evaluate` / `waitForFunction` are serialised and run
 * INSIDE the browser, but they are typechecked here — and the server package
 * compiles without the DOM lib. Name the handful of browser globals they touch
 * rather than dropping the whole file to `any`.
 */
declare const window: {
  location: { pathname: string; search: string };
  dispatchEvent(event: unknown): boolean;
};
declare const navigator: { serviceWorker?: { controller: unknown } };
declare const self: { dispatchEvent(event: unknown): boolean };
declare const performance: { getEntriesByType(type: string): unknown[] };
declare const caches: {
  open(name: string): Promise<{ put(url: string, response: unknown): Promise<void> }>;
};

/** The payload shape the service worker stores and the page consumes. */
interface Tap {
  id: string;
  url: string;
  tab_id: string | null;
  pane_id: string | null;
  ts: number;
}

let browser: Browser | null = null;
/**
 * Set only when Chromium was never DOWNLOADED (`npx playwright install
 * chromium`). Every other launch failure rethrows — a browser that exists and
 * won't start is a real failure, not an environment gap.
 */
let noBrowser = '';

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = String(err);
    if (!/Executable doesn't exist|playwright install/i.test(msg)) throw err;
    noBrowser = 'chromium not downloaded — run `npx playwright install chromium`';
  }
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

interface Instance {
  origin: string;
  /** workspace slug */
  ws: string;
  tabs: Array<{ id: string; slug: string; paneId: string }>;
  /** A SECOND workspace, one tab, so cross-workspace taps are testable. */
  other: { ws: string; tab: string; paneId: string };
  /** A second pane added to tabs[0], for the "same tab, other pane" case. */
  secondPaneInFirstTab: string;
  stop(): Promise<void>;
}

/**
 * An isolated muxpad: own free port, own MUXPAD_DATA_DIR-equivalent tmpdir, own
 * ptyd unix socket. Nothing here can touch the live daemon.
 */
async function startInstance(): Promise<Instance> {
  const dataDir = mkdtempSync(join(tmpdir(), 'push-warm-'));
  const db: Database.Database = openDb(join(dataDir, 'db.sqlite'));
  const ptyd: SpawnedPtyd = await spawnPtyd();
  const cache = new PtydCache();
  cache.attach(ptyd.client);
  const events = new EventBus();
  const app = createApp({ db, ptyd: ptyd.client, cache, dataDir, events });
  mountStaticWeb(app, WEB_DIST);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as unknown as Server;
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once('listening', () => r());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const wsHandle = attachWsServer({ http: server, db, ptyd: ptyd.client, cache, events });
  const origin = `http://127.0.0.1:${port}`;

  const post = async (path: string, body: unknown) => {
    const r = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
    return r.json() as Promise<Record<string, unknown>>;
  };

  const workspace = await post('/api/workspaces', { name: 'Alpha' });
  const tabs: Array<{ id: string; slug: string; paneId: string }> = [];
  for (const name of ['One', 'Two']) {
    const tab = (await post('/api/tabs', {
      workspace_id: workspace.id,
      name,
      bootstrap: 'shell',
    })) as { id: string; slug: string; layout: string };
    // A `bootstrap: 'shell'` tab is created with exactly one pane, and a
    // single-pane layout IS that pane's id.
    tabs.push({ id: tab.id, slug: tab.slug, paneId: tab.layout });
  }

  // A second pane in the first tab: the reported scenario is three agent panes
  // in ONE tab, where the tab is already on screen showing the wrong one.
  const extra = (await post(`/api/tabs/${tabs[0]?.id}/panes`, {
    append_to_layout: true,
  })) as { id: string };

  const otherWs = await post('/api/workspaces', { name: 'Beta' });
  const otherTab = (await post('/api/tabs', {
    workspace_id: otherWs.id,
    name: 'Far',
    bootstrap: 'shell',
  })) as { slug: string; layout: string };

  return {
    origin,
    ws: workspace.slug as string,
    tabs,
    other: { ws: otherWs.slug as string, tab: otherTab.slug, paneId: otherTab.layout },
    secondPaneInFirstTab: extra.id,
    async stop() {
      await wsHandle.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await ptyd.cleanup();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Wait for the service worker this page registered to be evaluable. */
async function serviceWorker(ctx: BrowserContext, page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== undefined, undefined, {
    timeout: 20_000,
  });
  const existing = ctx.serviceWorkers()[0];
  return existing ?? (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }));
}

/**
 * Fire a REAL notificationclick inside the REAL service worker.
 *
 * There is no API to deliver a push to a headless browser, so the payload is
 * handed straight to the handler the browser would have called. Everything
 * downstream — pickClient, focus, the MessageChannel ack, the Cache Storage
 * dead-drop, the page's message listener, the router — is production code.
 */
async function tapNotification(
  ctx: BrowserContext,
  page: Page,
  data: { url: string; tab_id?: string; pane_id?: string },
): Promise<void> {
  const sw = await serviceWorker(ctx, page);
  await sw.evaluate((payload) => {
    const ev = new Event('notificationclick') as Event & {
      notification: unknown;
      waitUntil: (p: Promise<unknown>) => void;
    };
    ev.notification = { close: () => {}, data: payload };
    ev.waitUntil = () => {};
    self.dispatchEvent(ev);
  }, data);
}

let instance: Instance | null = null;
let ctx: BrowserContext | null = null;

beforeEach(async () => {
  if (!browser) return;
  instance = await startInstance();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
});

afterEach(async () => {
  await ctx?.close();
  ctx = null;
  await instance?.stop();
  instance = null;
});

/** The app records its active pane in `?pane=` — the one observable that says
 *  "this exact pane is on screen", in the app's own words. */
async function landedOn(page: Page, wsSlug: string, tabSlug: string, paneId: string) {
  await page.waitForFunction(
    ([ws, tab, pane]) =>
      window.location.pathname === `/w/${ws}/t/${tab}` &&
      new URLSearchParams(window.location.search).get('pane') === pane,
    [wsSlug, tabSlug, paneId] as const,
    { timeout: 20_000 },
  );
}

describe('a notification tap on an app that is ALREADY OPEN', () => {
  it('leaves the tab it was on and activates the pane that rang', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const context = ctx!;
    const [one, two] = inst.tabs;
    const page = await context.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one!.slug}`);
    // Fully settled on the WRONG tab first — otherwise "it ended up on tab
    // two" proves nothing about focusing an existing client.
    await landedOn(page, inst.ws, one!.slug, one!.paneId);

    await tapNotification(context, page, {
      url: `/w/${inst.ws}/t/${two!.slug}?ptab=x&pane=${two!.paneId}`,
      tab_id: 'x',
      pane_id: two!.paneId,
    });

    await landedOn(page, inst.ws, two!.slug, two!.paneId);
    // No reload: the warm path routes through the SPA router, so every
    // terminal and websocket in the window survives the tap.
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
  }, 90_000);

  it('switches panes INSIDE the tab already on screen', async (t) => {
    if (noBrowser) return t.skip();
    // The literal report: three agent panes in one tab, one of them wants you.
    // The tab is already mounted with a different active pane, which is exactly
    // the case where the `?pane` URL seed is ignored by design (TabView only
    // seeds from the URL when it has no active pane yet). Only the show-pane
    // broadcast / focus store can move it.
    const inst = instance!;
    const context = ctx!;
    const one = inst.tabs[0]!;
    const page = await context.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one.slug}`);
    await landedOn(page, inst.ws, one.slug, one.paneId);

    await tapNotification(context, page, {
      url: `/w/${inst.ws}/t/${one.slug}?ptab=${one.id}&pane=${inst.secondPaneInFirstTab}`,
      tab_id: one.id,
      pane_id: inst.secondPaneInFirstTab,
    });
    await landedOn(page, inst.ws, one.slug, inst.secondPaneInFirstTab);
  }, 90_000);

  it('crosses WORKSPACES, whose tab list only loads after the navigation', async (t) => {
    if (noBrowser) return t.skip();
    // A cross-workspace deep link mounts a WorkspaceShell that has no tabs yet,
    // so the show-pane broadcast fires into a TabView that does not exist. The
    // once-only focus store is the backstop that has to carry it.
    const inst = instance!;
    const context = ctx!;
    const one = inst.tabs[0]!;
    const page = await context.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one.slug}`);
    await landedOn(page, inst.ws, one.slug, one.paneId);

    await tapNotification(context, page, {
      url: `/w/${inst.other.ws}/t/${inst.other.tab}?ptab=x&pane=${inst.other.paneId}`,
      tab_id: 'x',
      pane_id: inst.other.paneId,
    });
    await landedOn(page, inst.other.ws, inst.other.tab, inst.other.paneId);
  }, 90_000);

  it('lands the same tap on a DESKTOP window', async (t) => {
    if (noBrowser) return t.skip();
    // Desktop tabs default to the `tabbed` view mode, which is single-pane too
    // — so the pane switch has to work there, not just on the phone.
    const inst = instance!;
    const desktop = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const one = inst.tabs[0]!;
      const page = await desktop.newPage();
      await page.goto(`${inst.origin}/w/${inst.ws}/t/${one.slug}`);
      await landedOn(page, inst.ws, one.slug, one.paneId);
      await tapNotification(desktop, page, {
        url: `/w/${inst.ws}/t/${inst.tabs[1]!.slug}?ptab=y&pane=${inst.tabs[1]!.paneId}`,
        tab_id: 'y',
        pane_id: inst.tabs[1]!.paneId,
      });
      await landedOn(page, inst.ws, inst.tabs[1]!.slug, inst.tabs[1]!.paneId);
    } finally {
      await desktop.close();
    }
  }, 90_000);

  it('does not steal focus back on the NEXT foreground (the tap is spent)', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const context = ctx!;
    const [one, two] = inst.tabs;
    const page = await context.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one!.slug}`);
    await landedOn(page, inst.ws, one!.slug, one!.paneId);
    await tapNotification(context, page, {
      url: `/w/${inst.ws}/t/${two!.slug}?ptab=x&pane=${two!.paneId}`,
      tab_id: 'x',
      pane_id: two!.paneId,
    });
    await landedOn(page, inst.ws, two!.slug, two!.paneId);

    // The user goes back to tab one themselves…
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one!.slug}`);
    await landedOn(page, inst.ws, one!.slug, one!.paneId);
    // …then backgrounds and foregrounds the app, which re-drains the SW's
    // dead-drop. A spent tap must not yank them away again.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1500);
    expect(new URL(page.url()).pathname).toBe(`/w/${inst.ws}/t/${one!.slug}`);
  }, 90_000);
});

describe('a notification tap the app is not ready for yet', () => {
  it('is applied once the router mounts, not dropped', async (t) => {
    if (noBrowser) return t.skip();
    // The service worker's dead-drop is read at module scope — BEFORE
    // createRoot().render() has committed. Routing there goes nowhere, and the
    // app foregrounds on whatever it was showing: the reported bug, in the one
    // delivery channel an installed iOS PWA has left (no WindowClient.navigate,
    // and openWindow on a live app merely focuses it).
    const inst = instance!;
    const context = ctx!;
    const [one, two] = inst.tabs;
    const page = await context.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one!.slug}`);
    await landedOn(page, inst.ws, one!.slug, one!.paneId);

    const tap: Tap = {
      id: `tap-${Date.now()}`,
      url: `/w/${inst.ws}/t/${two!.slug}?ptab=x&pane=${two!.paneId}`,
      tab_id: 'x',
      pane_id: two!.paneId,
      ts: Date.now(),
    };
    await page.evaluate(async (deadDrop) => {
      const cache = await caches.open('muxpad-push-v1');
      await cache.put(
        '/__muxpad/push-target',
        new Response(JSON.stringify(deadDrop), { headers: { 'content-type': 'application/json' } }),
      );
    }, tap);

    // Reload onto the WRONG tab. Nothing but the dead-drop says otherwise.
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one!.slug}`);
    await landedOn(page, inst.ws, two!.slug, two!.paneId);
  }, 90_000);

  it('survives the workspace list still being in flight', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const context = ctx!;
    const [one, two] = inst.tabs;
    const page = await context.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${one!.slug}`);
    await landedOn(page, inst.ws, one!.slug, one!.paneId);

    // Every later workspace refresh hangs, so the app is mid-load when the tap
    // lands and stays there for a while afterwards.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/api/workspaces*', async (route) => {
      await held;
      await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // trigger a refresh

    await tapNotification(context, page, {
      url: `/w/${inst.ws}/t/${two!.slug}?ptab=x&pane=${two!.paneId}`,
      tab_id: 'x',
      pane_id: two!.paneId,
    });
    await page.waitForTimeout(500);
    release();
    await landedOn(page, inst.ws, two!.slug, two!.paneId);
  }, 90_000);
});
