import { chromium } from 'playwright-core';
export const BASE = 'http://127.0.0.1:17877';
export async function open({ w = 1000, h = 700, scale = 2, mobile = false } = {}) {
  const b = await chromium.connectOverCDP(
    `${process.env.MUXPAD_API_URL}/api/browsers/s-${process.env.MUXPAD_TAB_ID}/cdp`,
  );
  const ctx = await b.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
  });
  await ctx.addInitScript(() => {
    try {
      const k = 'muxpad.settings.v1';
      const v = JSON.parse(localStorage.getItem(k) || '{}');
      localStorage.setItem(k, JSON.stringify({ ...v, theme: 'riso' }));
    } catch {}
  });
  const page = await ctx.newPage();
  return { b, ctx, page };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Load a url and refuse to continue unless the riso theme is actually painted.
export async function go(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.theme, null, {
    timeout: 15000,
  });
  const t = await page.evaluate(() => document.documentElement.dataset.theme);
  if (t !== 'riso') throw new Error(`theme is ${t}, not riso — refusing to capture ${url}`);
}
