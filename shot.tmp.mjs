import { chromium } from '/Users/ohadpr/Dropbox/Computer/MyDev/2026/muxpad/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs';
const b = await chromium.connectOverCDP(`http://127.0.0.1:7777/api/browsers/s-${process.env.MUXPAD_TAB_ID}/cdp`, { timeout: 60000 });
const ctx = b.contexts()[0] ?? (await b.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1120, height: 1200 });
await page.goto('http://127.0.0.1:8913/index.html', { waitUntil: 'networkidle' });
for (const t of ['riso', 'memphis']) {
  await page.click(`[data-t="${t}"]`);
  await page.waitForTimeout(200);
  await (await page.$$('.opt'))[1].screenshot({ path: `/tmp/theme-${t}.png` });
}
await page.close();
console.log('ok');
