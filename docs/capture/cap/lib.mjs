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
  const page = await ctx.newPage();
  return { b, ctx, page };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
