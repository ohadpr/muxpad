// "muxpad often doesn't return to the right scroll position, it like jumps
// back in history."
//
// Round one proved the BOTTOM case: a reader pinned to the latest message comes
// back to the latest message. It shipped, and the report came back unchanged —
// because the complaint was never about the bottom. "Jumps back in HISTORY"
// means the viewport lands far UP, among older messages, which is the
// scrolled-back reader's case and it has its own machinery: the older-history
// pager, and a remembered position stored as a RATIO of the scroll range.
//
// A ratio only survives content growing BELOW it. Page older messages in — which
// is exactly what a reader parked in history keeps doing — and the document
// grows ABOVE the viewport, so the same ratio now names a completely different
// message. Every round trip that prepends a batch walks the reader further back.
//
// Nothing about that is reproducible without layout: it needs a real transcript
// big enough to page, a real byte-window pager, real wheel gestures, and a real
// display:none hide. So: an isolated muxpad (own port, own data dir, own ptyd
// socket), the real built bundle, real Chromium.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { openDb } from '../store/db.js';
import { type SpawnedPtyd, spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist');

/*
 * Callbacks handed to `evaluate` run INSIDE the browser but are typechecked
 * here, and the server package compiles without the DOM lib. Name the few
 * globals they touch rather than dropping the file to `any`.
 */
declare const document: {
  querySelector(sel: string): DomEl | null;
  querySelectorAll(sel: string): DomEl[];
};
interface DomEl {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  textContent: string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  click(): void;
  querySelectorAll(sel: string): DomEl[];
}

let browser: Browser | null = null;
/** Set only when Chromium was never DOWNLOADED. Other launch failures rethrow. */
let noBrowser = '';

beforeAll(async () => {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    noBrowser = 'web/dist missing — run `pnpm -r build` first';
    return;
  }
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

/**
 * The transcript this suite reads through.
 *
 * Every record is padded to ~4 KB on DISK (`pad`, a field nothing renders) but
 * carries a SHORT visible text. That decouples the two things the test needs to
 * control independently: the server's byte-window pager (128 KB per page, so
 * ~32 records land per batch and the log takes several pages to exhaust) and
 * the rendered height (a few hundred readable rows, not a 40,000 px document).
 *
 * `MSG-0042` prefixes make the message under the viewport top identifiable from
 * the page, which is the only assertion that means anything here: not "what is
 * scrollTop" — that number is meaningless once the document grows — but "which
 * message is the reader looking at".
 */
const MESSAGE_COUNT = 200;
/**
 * `padBytes` sets how many records fit in one 128 KB server page. 4 KB → ~32
 * records a page (the ordinary transcript). 30 KB → ~4, which is the
 * image-heavy transcript the fill-viewport pager exists for: the initial window
 * renders less than a screenful, so opening the chat fires a BURST of
 * older-history prepends. That burst is the case this suite has to cover — it
 * is the only one where the document grows ABOVE the reader while a remembered
 * position is being applied.
 */
function record(i: number, padBytes: number): string {
  const tag = `MSG-${String(i).padStart(4, '0')}`;
  return JSON.stringify({
    id: `e-${tag}`,
    ts: 1_700_000_000_000 + i * 1000,
    kind: i % 2 === 0 ? 'user' : 'assistant',
    text: `${tag} ${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '.repeat(4)}`,
    pad: 'x'.repeat(padBytes),
  });
}
function writeTranscript(dataDir: string, sid: string, padBytes: number): void {
  const dir = join(dataDir, 'agent-transcripts');
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < MESSAGE_COUNT; i++) lines.push(record(i, padBytes));
  writeFileSync(join(dir, `${sid}.jsonl`), `${lines.join('\n')}\n`);
}

interface Instance {
  origin: string;
  ws: string;
  chatTab: { slug: string; paneId: string };
  otherTab: { slug: string };
  /** The agent keeps talking — appends land as `live` events on every socket. */
  appendMessages(n: number): void;
  stop(): Promise<void>;
}

/**
 * The value MUXPAD_DATA_DIR had before this suite ran, restored in afterAll.
 * Vitest reuses worker processes across FILES, so leaving it pointed at a
 * deleted tmpdir would follow whatever runs next in the same worker.
 */
const originalDataDir = process.env.MUXPAD_DATA_DIR;
afterAll(() => {
  // `delete`, not `= undefined`: assigning to process.env stringifies, so the
  // suggested fix would leave the literal string "undefined" as the data dir.
  // biome-ignore lint/performance/noDelete: process.env assignment stringifies
  if (originalDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
  else process.env.MUXPAD_DATA_DIR = originalDataDir;
});

/** An isolated muxpad: own free port, own data dir, own ptyd socket. */
async function startInstance(padBytes = 4000): Promise<Instance> {
  const dataDir = mkdtempSync(join(tmpdir(), 'chat-scroll-'));
  // The muxpad-owned transcript log (the non-Claude backend path) is resolved
  // from MUXPAD_DATA_DIR at read time, so pointing it here keeps the suite
  // entirely off ~/.muxpad and ~/.claude.
  process.env.MUXPAD_DATA_DIR = dataDir;
  const db: Database.Database = openDb(join(dataDir, 'db.sqlite'));
  // Everything from here on is a real resource. `afterEach` can only clean up
  // through the returned handle, so a throw before we return would leak a ptyd
  // process and its socket dir for the rest of the run.
  const ptyd: SpawnedPtyd = await spawnPtyd();
  try {
    return await buildInstance({ padBytes, dataDir, db, ptyd });
  } catch (err) {
    await ptyd.cleanup();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
}

async function buildInstance({
  padBytes,
  dataDir,
  db,
  ptyd,
}: {
  padBytes: number;
  dataDir: string;
  db: Database.Database;
  ptyd: SpawnedPtyd;
}): Promise<Instance> {
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
  // `bootstrap: 'agent'` is the real product path for a chat pane: it mints the
  // pane with `startup_cmd: muxpad agent …` and `face: 'chat'`, which the write
  // path requires of each other.
  const chat = (await post('/api/tabs', {
    workspace_id: workspace.id,
    name: 'Chat',
    bootstrap: 'agent',
  })) as { id: string; slug: string; layout: string };
  const other = (await post('/api/tabs', {
    workspace_id: workspace.id,
    name: 'Other',
    bootstrap: 'shell',
  })) as { slug: string };

  // Bind the pane to a session whose transcript we wrote above.
  // `assistant: 'codex'` selects the muxpad-owned normalized log
  // (identityNormalize), so the fixture can be plain ChatEvents rather than
  // Claude's transcript schema — and nothing reads ~/.claude.
  const paneId = chat.layout;
  const sid = 'scroll-fixture-session';
  writeTranscript(dataDir, sid, padBytes);
  const agents = new AgentSessionStore(db);
  agents.attachRunner({ pane_id: paneId, session_id: sid, assistant: 'codex' });

  let nextIndex = MESSAGE_COUNT;
  return {
    origin,
    ws: workspace.slug as string,
    chatTab: { slug: chat.slug, paneId },
    otherTab: { slug: other.slug },
    appendMessages(n: number) {
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(record(nextIndex++, padBytes));
      appendFileSync(join(dataDir, 'agent-transcripts', `${sid}.jsonl`), `${lines.join('\n')}\n`);
    },
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

let instance: Instance | null = null;
let ctx: BrowserContext | null = null;

beforeEach(async () => {
  if (!browser) return;
  instance = await startInstance();
  ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
});

afterEach(async () => {
  await ctx?.close();
  ctx = null;
  await instance?.stop();
  instance = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many message rows are currently rendered — the paging progress signal. */
function rowCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.chat-scroll .chat-turn').length);
}

/**
 * The message the reader is actually looking at: the first row whose BOTTOM is
 * below the viewport top, plus how far its top sits above that line.
 *
 * This is the only stable way to state "where the reader was" across a document
 * whose height changes. scrollTop is not: prepend a batch of older history and
 * the same scrollTop names a message thousands of pixels later.
 */
async function topMessage(page: Page): Promise<{ tag: string; offset: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.chat-scroll');
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    for (const row of el.querySelectorAll('.chat-turn')) {
      const r = row.getBoundingClientRect();
      if (r.bottom > top + 1) {
        const m = /MSG-\d{4}/.exec(row.textContent ?? '');
        return m ? { tag: m[0], offset: Math.round(r.top - top) } : null;
      }
    }
    return null;
  });
}

/** `MSG-0071` → 71. Higher = later in the conversation. */
function msgIndex(tag: string): number {
  return Number.parseInt(tag.slice(4), 10);
}

async function scrollState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.chat-scroll');
    if (!el) return null;
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    };
  });
}

/**
 * Wait until the restore has finished moving the viewport.
 *
 * NOT a fixed sleep. The settling loop's base window is 2.5s, but a restore
 * that has to PAGE its remembered message back in extends its own deadline per
 * request — up to a 15s hard stop. A fixed 3.5s would sample the loop
 * mid-convergence on exactly the cases that matter, and would do it only on
 * slower machines: flaky by construction. So: poll the message under the
 * viewport top until it holds still, with a ceiling past the hard stop.
 */
async function restoreSettled(page: Page): Promise<void> {
  let last = '';
  let stable = 0;
  for (let i = 0; i < 130; i++) {
    const now = JSON.stringify(await topMessage(page));
    stable = now === last ? stable + 1 : 0;
    last = now;
    // ~1.2s of no movement, and never before the base settle window could have
    // even started re-asserting.
    if (stable >= 8 && i >= 12) return;
    await sleep(150);
  }
}

/** Wait until the chat has rendered rows and stopped growing for a beat. */
async function chatSettled(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.chat-scroll .chat-turn').length > 5,
      undefined,
      { timeout: 30_000 },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('DOM at timeout:', (await page.content()).slice(0, 4000));
    throw err;
  }
  // Two equal samples 150ms apart is SHORTER than one older-history round trip,
  // so it can return in the gap between prepend batches. Require a run of them,
  // and throw rather than falling through — a chat that never settles should
  // fail here, naming the real problem, not downstream in an assertion about
  // scroll position.
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 200; i++) {
    const n = await rowCount(page);
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 10) return;
    await sleep(150);
  }
  throw new Error(`chat never stopped growing (last row count ${last})`);
}

/**
 * A REAL wheel gesture. Programmatic `scrollTop =` is indistinguishable from
 * the component's own restores, so it would prove nothing about the reader
 * taking control — the gesture listener that clears the suppression window
 * only fires on wheel/touch.
 */
async function wheelUp(page: Page, notches: number): Promise<void> {
  const box = await page.locator('.chat-scroll').boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -400);
    await sleep(40);
  }
}

/** Switch to the other tab and back — the display:none hide/show the report is about. */
async function hideAndShow(page: Page, inst: Instance): Promise<void> {
  await page.click(`a[href="/w/${inst.ws}/t/${inst.otherTab.slug}"]`);
  // The chat pane stays MOUNTED behind display:none (the keep-alive stack), so
  // there is no DOM signal for "hidden" to wait on — wait for the other tab's
  // own surface to be on screen instead.
  await page.waitForSelector('.xterm', { timeout: 15_000 });
  await sleep(700);
  await page.click(`a[href="/w/${inst.ws}/t/${inst.chatTab.slug}"]`);
  await restoreSettled(page);
}

/**
 * Put the reader where the report is about: parked among OLDER messages, with
 * at least one batch of history paged in behind them and more still unpaged.
 * Wheel to the top to force pages, then wheel back down so the parked spot is
 * genuinely mid-log rather than the degenerate scrollTop-0 case (where every
 * scheme, right or wrong, agrees).
 */
async function parkInHistory(page: Page): Promise<void> {
  const before = await rowCount(page);
  for (let i = 0; i < 3; i++) {
    await wheelUp(page, 14);
    await sleep(900);
  }
  const after = await rowCount(page);
  expect(after).toBeGreaterThan(before); // older history really did page in
  await page.mouse.wheel(0, 1500); // back down off the very top
  await sleep(900);
}

describe('chat scroll position across a hide/show', () => {
  it('a reader parked in history comes back to the SAME message', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const page = await ctx!.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab.slug}`);
    await chatSettled(page);
    await parkInHistory(page);

    const parked = await topMessage(page);
    const parkedState = await scrollState(page);
    expect(parked).not.toBeNull();

    await hideAndShow(page, inst);

    const returned = await topMessage(page);
    const returnedState = await scrollState(page);
    // eslint-disable-next-line no-console
    console.log('[hide/show] parked', parked, parkedState, '→', returned, returnedState);
    expect(returned?.tag).toBe(parked?.tag);
  }, 180_000);

  it('a reader parked in history survives the agent talking while they were away', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const page = await ctx!.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab.slug}`);
    await chatSettled(page);
    await parkInHistory(page);
    const parked = await topMessage(page);

    await page.click(`a[href="/w/${inst.ws}/t/${inst.otherTab.slug}"]`);
    await sleep(600);
    inst.appendMessages(12);
    await sleep(1500);
    await page.click(`a[href="/w/${inst.ws}/t/${inst.chatTab.slug}"]`);
    await restoreSettled(page);

    const returned = await topMessage(page);
    // eslint-disable-next-line no-console
    console.log('[append while away] parked', parked, '→', returned, await scrollState(page));
    expect(returned?.tag).toBe(parked?.tag);
  }, 180_000);

  it('a reader parked in history survives a reload', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const page = await ctx!.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab.slug}`);
    await chatSettled(page);
    await parkInHistory(page);
    const parked = await topMessage(page);

    await page.reload();
    await chatSettled(page);
    await restoreSettled(page);

    const returned = await topMessage(page);
    // eslint-disable-next-line no-console
    console.log('[reload] parked', parked, '→', returned, await scrollState(page));
    expect(returned?.tag).toBe(parked?.tag);
  }, 180_000);

  it('a reader parked in history survives a browser-tab background/foreground', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const page = await ctx!.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab.slug}`);
    await chatSettled(page);
    await parkInHistory(page);
    const parked = await topMessage(page);

    // A second page in the same context backgrounds the first, which is the
    // real visibilitychange the pane listens for (`showEpoch`).
    const decoy = await ctx!.newPage();
    await decoy.goto('about:blank');
    await decoy.bringToFront();
    await sleep(1200);
    await page.bringToFront();
    await restoreSettled(page);

    const returned = await topMessage(page);
    // eslint-disable-next-line no-console
    console.log('[bg/fg] parked', parked, '→', returned, await scrollState(page));
    expect(returned?.tag).toBe(parked?.tag);
  }, 180_000);

  it('survives the burst of prepends a fat transcript fires on open', async (t) => {
    if (noBrowser) return t.skip();
    // The shape that produces the literal report. Records are fat on disk, so
    // the server's initial 128 KB window holds only a handful and renders SHORT
    // of a screenful — which makes the client fire a BURST of older-history
    // prepends on every open.
    //
    // Each of those batches grows the document ABOVE the viewport. A remembered
    // RATIO re-applied against the grown document gives R·(range + grown),
    // always LESS than the honest R·range + grown for R < 1 — and because the
    // settling loop re-applies it every frame, it OVERRIDES the prepend
    // compensation instead of losing to it. So every batch dragged the reader
    // further back into older history. An anchored message is immune: the loop
    // and the compensation compute the same position.
    await instance!.stop();
    instance = await startInstance(30_000);
    const inst = instance;
    const page = await ctx!.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab.slug}`);
    await chatSettled(page);
    // A gentle park — a few screens back, well inside the anchor seek's page
    // budget. (The deep-park case is the test below.)
    await wheelUp(page, 12);
    await sleep(1400);
    const parked = await topMessage(page);
    const parkedState = await scrollState(page);

    // A reload is what puts the log back to the small initial window, which is
    // the precondition for the burst. (A display:none hide keeps the pane
    // mounted with every paged-in batch still rendered, so nothing prepends.)
    await page.reload();
    await chatSettled(page);
    await restoreSettled(page);

    const returned = await topMessage(page);
    // eslint-disable-next-line no-console
    console.log(
      '[burst pager] parked',
      parked,
      parkedState,
      '→',
      returned,
      await scrollState(page),
    );
    expect(returned?.tag).toBe(parked?.tag);
  }, 240_000);

  it('degrades toward the TAIL, never deeper into history, past the seek budget', async (t) => {
    if (noBrowser) return t.skip();
    // The seek that re-pages a remembered message back in is deliberately
    // bounded (ANCHOR_SEEK_PAGE_BUDGET): each page is a socket round trip of up
    // to 128 KB, and no restore is worth pulling megabytes. A reader who had
    // hand-scrolled further back than the budget reaches therefore CANNOT be
    // put back exactly — so the property that matters is the direction of the
    // miss. Landing short (nearer the latest message) is a shrug; landing
    // deeper is the reported symptom.
    //
    // Honest about what this proves: it is a REGRESSION GUARD, not a repro —
    // the pre-fix code passes it too, because a reload's window only holds
    // recent messages, so every pre-fix miss also happened to land toward the
    // tail. What it guards is the seek's own fallback: eight prepended pages
    // grow the document above the reader, and re-deriving position from the
    // stored ratio each frame would drag them backward through every one of
    // them — worse than pre-fix. That is why the fallback freezes onto a row
    // after its first application.
    await instance!.stop();
    instance = await startInstance(30_000);
    const inst = instance;
    const page = await ctx!.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab.slug}`);
    await chatSettled(page);
    await parkInHistory(page); // deep: repeated trips to the very top
    const parked = await topMessage(page);

    await page.reload();
    await chatSettled(page);
    await restoreSettled(page);

    const returned = await topMessage(page);
    // eslint-disable-next-line no-console
    console.log('[beyond budget] parked', parked, '→', returned, await scrollState(page));
    expect(returned).not.toBeNull();
    expect(msgIndex(returned!.tag)).toBeGreaterThanOrEqual(msgIndex(parked!.tag));
  }, 240_000);

  it('a reader pinned to the bottom comes back to the bottom', async (t) => {
    if (noBrowser) return t.skip();
    const inst = instance!;
    const page = await ctx!.newPage();
    await page.goto(`${inst.origin}/w/${inst.ws}/t/${inst.chatTab.slug}`);
    await chatSettled(page);

    const parked = await topMessage(page);
    expect(parked).not.toBeNull();

    await hideAndShow(page, inst);

    const state = await scrollState(page);
    expect(state).not.toBeNull();
    expect(state!.fromBottom).toBeLessThan(40);
  }, 180_000);
});
