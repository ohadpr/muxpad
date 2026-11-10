import { chromium } from '/Users/ohadpr/Dropbox/Computer/MyDev/2026/muxpad/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs';
const b = await chromium.connectOverCDP(`http://127.0.0.1:7777/api/browsers/s-${process.env.MUXPAD_TAB_ID}/cdp`, { timeout: 60000 });
const ctx = b.contexts()[0] ?? (await b.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1180, height: 1400 });
await page.goto('http://127.0.0.1:8911/index.html', { waitUntil: 'networkidle' });
await page.screenshot({ path: '/tmp/rt-shot.png', fullPage: true });
await page.close();
console.log('screenshot taken');
