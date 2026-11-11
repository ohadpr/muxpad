#!/usr/bin/env node
// `muxpad browser probe` — ask a page several questions in ONE call.
//
// Measured across 10 agent sessions (perf/turn-economics): every browser
// question cost 3+ round trips (navigate, a fixed sleep, evaluate, screenshot)
// or a hand-written Playwright script that launched or connected, slept ~4 s
// and measured one thing. 953 runs of consecutive browser steps, 3,086 steps,
// ~3 h of model time between them; 164 of 170 hand-written scripts slept a
// fixed interval instead of waiting for a condition.
//
// This reuses the pane's own warm muxpad browser (the CDP endpoint the
// instructions name), waits for a CONDITION rather than a clock, runs every
// --eval against the same loaded page, and prints one JSON object.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `usage:
  muxpad browser probe <url> [--eval=JS]... [--until=JS] [--shot=PATH]
                             [--size=WxH] [--timeout=SEC]

  Loads <url> in THIS pane's muxpad browser, waits for --until (a JS
  expression, polled until truthy) or for the load event, then evaluates every
  --eval on that same page and prints one JSON object:
    {url, status, title, ms, until, evals:[{expr, value|error}], errors, shot}
  Exit 0 answered · 1 usage or connection failure · 3 --until timed out.

  Ask everything you want to know about a page in one probe:
    muxpad browser probe http://127.0.0.1:5173/ --until="document.querySelector('.chat')" \\
      --eval="document.querySelectorAll('.row').length" \\
      --eval="getComputedStyle(document.querySelector('.bar')).height" --shot=/tmp/a.png`;

export function parseArgs(argv) {
  const o = { url: null, evals: [], until: null, shot: null, size: null, timeoutMs: 15000 };
  for (const a of argv) {
    const m = /^--([a-z]+)=(.*)$/s.exec(a);
    if (a === '-h' || a === '--help') return { help: true };
    if (!m) {
      if (a.startsWith('--')) return { error: `unknown flag ${a}` };
      if (o.url) return { error: `one url per probe (got ${o.url} and ${a})` };
      o.url = a;
      continue;
    }
    const [, k, v] = m;
    if (k === 'eval') o.evals.push(v);
    else if (k === 'until') o.until = v;
    else if (k === 'shot') o.shot = v;
    else if (k === 'size') {
      const s = /^(\d+)x(\d+)$/.exec(v);
      if (!s) return { error: `--size wants WxH, got ${v}` };
      o.size = { width: Number(s[1]), height: Number(s[2]) };
    } else if (k === 'timeout') {
      const n = Number(v);
      if (!(n > 0)) return { error: `--timeout wants seconds, got ${v}` };
      o.timeoutMs = n * 1000;
    } else return { error: `unknown flag --${k}` };
  }
  if (!o.url) return { error: 'a url is required' };
  return o;
}

export function cdpUrl(env) {
  const tab = env.MUXPAD_TAB_ID;
  if (!tab) return null;
  const base = (env.MUXPAD_API_URL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
  return `${base}/api/browsers/s-${encodeURIComponent(tab)}/cdp`;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) return void console.log(USAGE);
  if (o.error) {
    console.error(`muxpad browser probe: ${o.error}\n\n${USAGE}`);
    return 1;
  }
  const endpoint = cdpUrl(process.env);
  if (!endpoint) {
    console.error('muxpad browser probe: no MUXPAD_TAB_ID — run it from inside a muxpad pane');
    return 1;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { chromium } = createRequire(join(root, 'server', 'package.json'))('playwright');
  const t0 = Date.now();
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: o.timeoutMs });
  } catch (e) {
    const msg = String(e?.message ?? e);
    // A 409 means a PERSON has the wheel. Not an error to work around.
    if (/409/.test(msg))
      console.error(
        'muxpad browser probe: a person has this browser right now — wait for them to hand it back',
      );
    else
      console.error(
        `muxpad browser probe: could not reach the muxpad browser at ${endpoint}: ${msg.split('\n')[0]}`,
      );
    return 1;
  }
  const out = {
    url: o.url,
    status: null,
    title: null,
    ms: 0,
    until: null,
    evals: [],
    errors: [],
    shot: null,
  };
  let code = 0;
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  try {
    page.on('pageerror', (e) => out.errors.push(String(e?.message ?? e)));
    page.on('console', (m) => m.type() === 'error' && out.errors.push(m.text()));
    if (o.size) await page.setViewportSize(o.size);
    const res = await page.goto(o.url, { timeout: o.timeoutMs, waitUntil: 'load' });
    out.status = res?.status() ?? null;
    if (o.until) {
      const u0 = Date.now();
      try {
        await page.waitForFunction(o.until, null, { timeout: o.timeoutMs, polling: 100 });
        out.until = { ok: true, ms: Date.now() - u0 };
      } catch (e) {
        out.until = {
          ok: false,
          ms: Date.now() - u0,
          error: String(e?.message ?? e).split('\n')[0],
        };
        code = 3;
      }
    }
    for (const expr of o.evals) {
      try {
        out.evals.push({ expr, value: await page.evaluate(expr) });
      } catch (e) {
        out.evals.push({ expr, error: String(e?.message ?? e).split('\n')[0] });
      }
    }
    out.title = await page.title();
    out.url = page.url();
    if (o.shot) {
      await page.screenshot({ path: o.shot });
      out.shot = o.shot;
    }
  } catch (e) {
    out.errors.push(String(e?.message ?? e).split('\n')[0]);
    code = 1;
  } finally {
    out.ms = Date.now() - t0;
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  console.log(JSON.stringify(out, null, 2));
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c ?? 0));
}
