// Does the artifact sandbox actually let a published artifact RENDER?
//
// `Content-Security-Policy: sandbox …` is the one header on the public port
// that can silently destroy content instead of merely refusing it: a bare
// `sandbox` still returns 200 with the right bytes, and the page just sits
// there as dead layout with no chart, no filter and no navigation. A header
// assertion cannot see that. Only a browser can.
//
// So this suite runs the REAL public app against artifacts shaped like the
// ones muxpad actually hosts — agent-generated HTML with an inline <style>, an
// inline <script> that builds the DOM, a relative link to a second page, a
// sibling data file loaded by fetch(), and an inline SVG — and asserts both
// halves at once:
//
//   1. RENDER: the script ran, the DOM it built is there, relative navigation
//      works, and the artifact's own data file loads.
//   2. ISOLATE: the document is in an OPAQUE origin, so artifact A cannot read
//      artifact B's storage — the thing the sandbox is for.
//
// Skips (does not fail) when Chromium was never downloaded, like the other
// integration suites here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { type Browser, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicApp } from '../public-server.js';

/*
 * The `evaluate` callbacks below run INSIDE the browser but are typechecked
 * here, and the server package compiles without the DOM lib. Name the two
 * globals they touch rather than dropping the file to `any` (same trick as
 * chat-scroll-e2e.test.ts).
 */
declare const document: { getElementById(id: string): { textContent: string | null } | null };
declare const window: { origin: string };

let browser: Browser | null = null;
/** Set only when Chromium was never DOWNLOADED. Other launch failures rethrow. */
let noBrowser = '';
let server: Server | null = null;
let base = '';
let root = '';

/** A page shaped like what an agent publishes: inline style + inline script. */
function artifactPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;background:#111;color:#eee}.card{padding:8px}</style>
</head><body>${body}</body></html>`;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'muxpad-csp-'));
  const pub = join(root, 'public');

  // Artifact A — a "report": inline script builds the DOM, fetches its own
  // data file, links to a second page, and carries an inline SVG chart.
  mkdirSync(join(pub, 'report'), { recursive: true });
  writeFileSync(join(pub, 'report', 'data.json'), JSON.stringify({ rows: [1, 2, 3] }));
  writeFileSync(
    join(pub, 'report', 'index.html'),
    artifactPage(
      'Report',
      `<div id="out">not-run</div>
<div id="rows">no-data</div>
<svg id="chart" width="40" height="10"><rect width="40" height="10" fill="#4af"></rect></svg>
<a id="next" href="detail.html">detail</a>
<div id="storage">untested</div>
<script>
  document.getElementById('out').textContent = 'script-ran';
  try { localStorage.setItem('k', 'v'); document.getElementById('storage').textContent = 'storage-open'; }
  catch (e) { document.getElementById('storage').textContent = 'storage-denied'; }
  fetch('data.json')
    .then((r) => r.json())
    .then((d) => { document.getElementById('rows').textContent = 'rows-' + d.rows.length; })
    .catch((e) => { document.getElementById('rows').textContent = 'fetch-failed'; });
</script>`,
    ),
  );
  writeFileSync(
    join(pub, 'report', 'detail.html'),
    artifactPage('Detail', '<div id="page">detail-page</div>'),
  );

  const app = createPublicApp(pub);
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as unknown as Server;
  await new Promise<void>((r) => {
    if (server?.listening) return r();
    server?.once('listening', () => r());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

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
  server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * ONE browser, ONE page load for the whole suite.
 *
 * Not an optimisation for its own sake: this file runs alongside two other
 * Chromium-driving suites (chat-scroll-e2e, push-warm-focus) under vitest's
 * file parallelism, and those are already close to their timeouts on a loaded
 * machine. A page-per-assertion here pushed them over. The artifact is static,
 * so every assertion below reads the SAME loaded document anyway — splitting
 * it across contexts proved nothing extra.
 */
let page: Page | null = null;
const pageErrors: string[] = [];

describe('published artifacts render under the sandbox CSP', () => {
  beforeAll(async () => {
    if (!browser) return;
    page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${base}/report/`, { waitUntil: 'load' });
  }, 60_000);

  it('runs the inline script and paints what it builds', async (ctx) => {
    if (!page) return ctx.skip(); // SKIP, not silently green — see noBrowser
    expect(await page.textContent('#out')).toBe('script-ran');
    // The inline style applied and the SVG has real layout. Under a bare
    // `sandbox` the markup is still present and still 200s — but #out stays
    // 'not-run'. Both assertions together mean "looks like the artifact",
    // not merely "the bytes arrived".
    const box = await page.locator('#chart').boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    expect(pageErrors.filter((e) => /Content Security|sandbox/i.test(e))).toEqual([]);
  });

  it('loads the artifact’s own sibling data file (the ACAO covers the opaque origin)', async (ctx) => {
    if (!page) return ctx.skip();
    // Without `access-control-allow-origin: null` the sandbox's opaque origin
    // makes this same-directory fetch a blocked cross-origin request, and a
    // data-driven dashboard renders empty with a 200 in the network tab.
    await page.waitForFunction(
      () => document.getElementById('rows')?.textContent !== 'no-data',
      undefined,
      { timeout: 10_000 },
    );
    expect(await page.textContent('#rows')).toBe('rows-3');
  });

  it('puts the document in an OPAQUE origin — no shared artifact storage', async (ctx) => {
    if (!page) return ctx.skip();
    // The point of the header. Every artifact on this one public origin used
    // to share a storage bucket with every other; now there is no bucket, so
    // there is nothing for the next agent-written page to read.
    expect(await page.evaluate(() => window.origin)).toBe('null');
    expect(await page.textContent('#storage')).toBe('storage-denied');
  });

  it('follows a relative link to the artifact’s second page', async (ctx) => {
    if (!page) return ctx.skip();
    // Multi-page artifacts are the norm (ui-ubiquiti/item/*.html,
    // acme-gtm-c001/*.html), so the tray of relative links has to keep
    // working. A sandboxed document may always navigate ITSELF, so this
    // passes with or without allow-top-navigation-by-user-activation — the
    // token is there for the framed case (a muxpad URL pane), and this test
    // is here because "the nav still works" is the thing that would be
    // noticed. Runs LAST: it navigates the shared page away from /report/.
    await page.click('#next');
    await page.waitForURL(/detail\.html$/, { timeout: 10_000 });
    expect(await page.textContent('#page')).toBe('detail-page');
  });

  it('serves a navigated .svg with the sandbox too', async () => {
    // No browser needed: an SVG is a script-bearing document when navigated
    // to directly, and what matters is that it gets the same opaque origin as
    // everything else on this port rather than the shared one.
    writeFileSync(
      join(root, 'public', 'report', 'x.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    const res = await fetch(`${base}/report/x.svg`);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox\b/);
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    await res.arrayBuffer();
  });
});
