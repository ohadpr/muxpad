// Mobile dictation cleanup, driven through a real browser against a real
// isolated muxpad.
//
// The affordance's whole value proposition is a sequence of DOM facts that no
// unit test can assert: the button is there on a phone, it is NOT there on a
// desktop, tapping it replaces the composer text, and tapping undo puts the
// original back — with nothing ever being sent to the pane along the way.
//
// Isolation: own free port, own data dir, own ptyd unix socket, and a STUBBED
// cleanup model injected into createApp. No live daemon, no ~/.muxpad, and no
// network call to Anthropic.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type Database from 'better-sqlite3';
import { type Browser, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CleanupModel } from '../chat/clean-transcript.js';
import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { createApp } from '../server.js';
import { mountStaticWeb } from '../static-assets.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(HERE, '..', '..', '..', 'web', 'dist');
/** Screenshots land beside the repo's other captured evidence. */
const SHOTS = join(HERE, '..', '..', '..', 'test-results', 'dictation-cleanup');

const DICTATED = 'check the crown schedule on Max pad for Ohio';
const CLEANED = 'check the cron schedule on muxpad for ohados';

/* vitest's `expect.poll` defaults to a 1s window — far too tight when this
   file runs alongside the rest of the server suite on a loaded machine. Every
   poll here is waiting on a browser round trip, so give them all real room. */
const POLL = { timeout: 15_000 };

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/*
 * The callback handed to `addInitScript` is serialised and runs INSIDE the
 * browser, but it is typechecked here — and the server package compiles without
 * the DOM lib. Name the one global it touches rather than dropping the file to
 * `any` (same approach as push-warm-focus.test.ts).
 */
declare const window: {
  addEventListener(type: string, listener: (e: { detail: unknown }) => void): void;
  __muxpadSent(detail: unknown): void;
};

let browser: Browser | null = null;
/** Set only when Chromium was never downloaded / web/dist was never built —
 *  every other launch failure rethrows. */
let skip = '';

beforeAll(async () => {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    skip = 'web/dist missing — run `pnpm -r build` first';
    return;
  }
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = String(err);
    if (!/Executable doesn't exist|playwright install/i.test(msg)) throw err;
    skip = 'chromium not downloaded — run `npx playwright install chromium`';
  }
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

interface Instance {
  origin: string;
  ws: string;
  tab: string;
  /** A second tab holding an agent pane parked on its CHAT face, so the chat
   *  composer's own copy of the affordance is exercised too. */
  chatTab: string;
  /** Prompts the stub model was handed — proves the glossary reached it. */
  prompts: string[];
  /** Flip to make the next cleanup call fail, for the unreachable-model case. */
  fail: { now: boolean };
  /** Hold the next cleanup call open, for the racing-a-send case. */
  delay: { ms: number };
  stop(): Promise<void>;
}

async function startInstance(): Promise<Instance> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dictation-'));
  const db: Database.Database = openDb(join(dataDir, 'db.sqlite'));
  const ptyd: SpawnedPtyd = await spawnPtyd();
  const cache = new PtydCache();
  cache.attach(ptyd.client);
  const events = new EventBus();

  const prompts: string[] = [];
  const fail = { now: false };
  const delay = { ms: 0 };
  // The stub IS the seam AppDeps.cleanupModel exists for. It never touches the
  // network, and it returns a fixed correction so the assertions are exact.
  const cleanupModel: CleanupModel = async (prompt) => {
    prompts.push(prompt);
    if (delay.ms > 0) await new Promise((r) => setTimeout(r, delay.ms));
    if (fail.now) throw new Error('stubbed model outage');
    return CLEANED;
  };

  const app = createApp({ db, ptyd: ptyd.client, cache, dataDir, events, cleanupModel });
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

  const workspace = await post('/api/workspaces', { name: 'Trayo GTM' });
  const tab = (await post('/api/tabs', {
    workspace_id: workspace.id,
    name: 'artifact lifecycle',
    bootstrap: 'shell',
  })) as { slug: string };

  // A tab whose single pane is an agent pane showing chat. `startup_cmd` only
  // has to LOOK like an agent launch (the route gates the chat face on it) —
  // the pty it spawns is irrelevant here; what makes the composer render is a
  // registered agent session with a current sid.
  const chatTab = (await post('/api/tabs', {
    workspace_id: workspace.id,
    name: 'chat',
  })) as { id: string; slug: string };
  const chatPane = (await post(`/api/tabs/${chatTab.id}/panes`, {
    append_to_layout: true,
    face: 'chat',
    startup_cmd: 'muxpad agent',
  })) as { id: string };
  await post('/api/agent-sessions/register', {
    pane_id: chatPane.id,
    assistant: 'claude',
    session_id: '11111111-2222-3333-4444-555555555555',
  });

  return {
    origin,
    ws: workspace.slug as string,
    tab: tab.slug,
    chatTab: chatTab.slug,
    prompts,
    fail,
    delay,
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

/** Put text in the contenteditable composer the way a keyboard would, so React's
 *  input handler runs (the bar tracks emptiness off `input` events). */
async function typeIntoComposer(page: Page, text: string) {
  const box = page.locator('.mobile-input-editable');
  await box.click();
  await box.pressSequentially(text, { delay: 1 });
}

const composerText = (page: Page) =>
  page.locator('.mobile-input-editable').evaluate((el) => el.textContent ?? '');

/* Both composers can be in the DOM at once (the terminal bar stays mounted,
   `hidden`, while a pane shows its chat face), so every cleanup locator is
   scoped to the composer under test — otherwise `getByTestId` matches twice. */
const inBar = (page: Page, id: string) => page.locator('.mobile-input-bar').getByTestId(id);
const inChat = (page: Page, id: string) => page.locator('.chat-composer').getByTestId(id);

describe('mobile dictation cleanup (browser)', () => {
  let inst: Instance;

  beforeAll(async () => {
    if (skip) return;
    mkdirSync(SHOTS, { recursive: true });
    inst = await startInstance();
  }, 120_000);

  afterAll(async () => {
    await inst?.stop();
  });

  it('cleans the composer on tap, shows what changed, and undo restores it', async (t) => {
    if (skip) return t.skip();
    const ctx = await browser?.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    if (!ctx) throw new Error('no browser context');
    const page = await ctx.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.tab}`);

    const clean = inBar(page, 'cleanup-run');
    await clean.waitFor({ state: 'visible', timeout: 20_000 });
    // Disabled while there is nothing to clean — the rule is state, not a
    // fuzzy guess about whether the text "looks garbled".
    await expect.poll(() => clean.isDisabled(), POLL).toBe(true);

    await typeIntoComposer(page, DICTATED);
    await expect.poll(() => clean.isDisabled(), POLL).toBe(false);
    await page.screenshot({ path: join(SHOTS, 'mobile-before.png') });

    await clean.tap();
    // Applied: composer rewritten, undo offered, and the change named.
    await expect.poll(() => composerText(page), POLL).toBe(CLEANED);
    const undo = inBar(page, 'cleanup-undo');
    await undo.waitFor({ state: 'visible', timeout: 10_000 });
    const hint = await inBar(page, 'cleanup-hint').textContent();
    expect(hint).toContain('crown → cron');
    expect(hint).toContain('Max pad → muxpad');
    await page.screenshot({ path: join(SHOTS, 'mobile-after.png') });

    // The glossary really was built from this install's live names.
    const prompt = inst.prompts[0] ?? '';
    expect(prompt).toContain(DICTATED);
    expect(prompt).toContain('muxpad');
    expect(prompt).toContain('Trayo GTM');
    expect(prompt).toContain('artifact lifecycle');

    // Reversible: one tap and the dictation is back, verbatim.
    await undo.tap();
    await expect.poll(() => composerText(page), POLL).toBe(DICTATED);
    await expect.poll(() => inBar(page, 'cleanup-run').isVisible(), POLL).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'mobile-undone.png') });

    await ctx.close();
  }, 120_000);

  it('never sends on its own — cleanup only rewrites the composer', async (t) => {
    if (skip) return t.skip();
    const ctx = await browser?.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    if (!ctx) throw new Error('no browser context');
    const page = await ctx.newPage();
    // Watch the pane input channel: a cleanup that submitted would show up here.
    const sent: unknown[] = [];
    await page.exposeFunction('__muxpadSent', (d: unknown) => sent.push(d));
    await page.addInitScript(() => {
      window.addEventListener('muxpad:send-input', (e) => window.__muxpadSent(e.detail));
    });
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.tab}`);

    const clean = inBar(page, 'cleanup-run');
    await clean.waitFor({ state: 'visible', timeout: 20_000 });
    await typeIntoComposer(page, DICTATED);
    await clean.tap();
    await expect.poll(() => composerText(page), POLL).toBe(CLEANED);
    expect(sent).toEqual([]);

    await ctx.close();
  }, 120_000);

  it('says so, loudly, when the model cannot be reached', async (t) => {
    if (skip) return t.skip();
    const ctx = await browser?.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    if (!ctx) throw new Error('no browser context');
    const page = await ctx.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.tab}`);

    const clean = inBar(page, 'cleanup-run');
    await clean.waitFor({ state: 'visible', timeout: 20_000 });
    await typeIntoComposer(page, DICTATED);
    inst.fail.now = true;
    await clean.tap();

    const hint = inBar(page, 'cleanup-hint');
    await hint.waitFor({ state: 'visible', timeout: 15_000 });
    expect(await hint.textContent()).toMatch(/couldn.t clean that up/i);
    // …and the composer is untouched, so nothing was silently swallowed.
    expect(await composerText(page)).toBe(DICTATED);
    await page.screenshot({ path: join(SHOTS, 'mobile-error.png') });
    inst.fail.now = false;

    await ctx.close();
  }, 120_000);

  // The chat composer is the other half: unlike the terminal bar it renders on
  // BOTH layouts, so it carries the viewport gate itself — and it is the
  // composer that drives an agent that runs tool calls.
  it('offers the same review-then-undo in the mobile chat composer', async (t) => {
    if (skip) return t.skip();
    const ctx = await browser?.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    if (!ctx) throw new Error('no browser context');
    const page = await ctx.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab}`);

    const box = page.locator('.chat-input');
    await box.waitFor({ state: 'visible', timeout: 20_000 });
    const clean = inChat(page, 'cleanup-run');
    await clean.waitFor({ state: 'visible', timeout: 20_000 });
    await expect.poll(() => clean.isDisabled(), POLL).toBe(true);

    await box.fill(DICTATED);
    await expect.poll(() => clean.isDisabled(), POLL).toBe(false);
    await page.screenshot({ path: join(SHOTS, 'chat-mobile-before.png') });

    await clean.tap();
    await expect.poll(() => box.inputValue(), POLL).toBe(CLEANED);
    const undo = inChat(page, 'cleanup-undo');
    await undo.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await inChat(page, 'cleanup-hint').textContent()).toContain('crown → cron');
    await page.screenshot({ path: join(SHOTS, 'chat-mobile-after.png') });

    await undo.tap();
    await expect.poll(() => box.inputValue(), POLL).toBe(DICTATED);
    // Nothing left the composer: no user bubble, live or queued. This is the
    // composer that drives tool calls, so "review before send" has to hold here
    // most of all.
    expect(await page.locator('.chat-turn-user').count()).toBe(0);

    await ctx.close();
  }, 120_000);

  // Regression: the model call takes seconds, which is ample time to hit Send.
  // Without a generation guard the late response repopulated the (now empty)
  // composer with the cleaned copy of a message that had already gone out —
  // one more Send away from duplicating it to an agent that runs tool calls.
  it('drops a cleanup whose result arrives after the message was sent', async (t) => {
    if (skip) return t.skip();
    const ctx = await browser?.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    if (!ctx) throw new Error('no browser context');
    const page = await ctx.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.tab}`);

    const clean = inBar(page, 'cleanup-run');
    await clean.waitFor({ state: 'visible', timeout: 20_000 });
    await typeIntoComposer(page, DICTATED);

    inst.delay.ms = 2_500;
    await clean.tap();
    // Send while the cleanup is still in flight.
    await page.locator('.mobile-input-send').tap();
    await expect.poll(() => composerText(page), POLL).toBe('');

    // Well past the stubbed model's delay: the composer must still be empty and
    // no undo may be offered over text the user never composed.
    await page.waitForTimeout(3_500);
    expect(await composerText(page)).toBe('');
    expect(await inBar(page, 'cleanup-undo').count()).toBe(0);
    inst.delay.ms = 0;

    await ctx.close();
  }, 120_000);

  it('is absent on desktop — in both composers', async (t) => {
    if (skip) return t.skip();
    const ctx = await browser?.newContext({ viewport: DESKTOP });
    if (!ctx) throw new Error('no browser context');
    const page = await ctx.newPage();

    // Terminal pane: the whole mobile bar is desktop-absent by construction.
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.tab}`);
    await page.locator('.workspace-root').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(1_000);
    expect(await page.getByTestId('cleanup-run').count()).toBe(0);
    expect(await page.getByTestId('cleanup-undo').count()).toBe(0);
    await page.screenshot({ path: join(SHOTS, 'desktop-absent.png') });

    // Chat pane: this composer DOES render on desktop, so this is the real
    // assertion that the viewport gate holds.
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab}`);
    await page.locator('.chat-input').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('.chat-send').waitFor({ state: 'visible', timeout: 10_000 });
    expect(await inChat(page, 'cleanup-run').count()).toBe(0);
    expect(await page.getByTestId('cleanup-run').count()).toBe(0);
    await page.screenshot({ path: join(SHOTS, 'desktop-chat-absent.png') });

    await ctx.close();
  }, 120_000);
});
