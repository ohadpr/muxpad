import { execFileSync } from 'node:child_process';
// Stills for the README, captured at 2x from the isolated demo instance.
import { mkdirSync, readFileSync } from 'node:fs';
import { open, sleep } from './lib.mjs';
const ids = Object.fromEntries(
  readFileSync('/private/tmp/mxd/ids.sh', 'utf8')
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i), s.slice(i + 1)];
    }),
);
const OUT = '/private/tmp/mxd/out';
mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
const want = (k) => !only || only.split(',').includes(k);

if (want('chat') || want('drawer') || want('rail')) {
  const { b, ctx, page } = await open({ w: 1000, h: 700 });
  await page.goto(ids.pt_url);
  await sleep(3000);
  if (want('chat')) await page.screenshot({ path: `${OUT}/chat-light.png` });
  if (want('rail')) {
    await page.screenshot({
      path: `${OUT}/state-rail.png`,
      clip: { x: 0, y: 0, width: 280, height: 700 },
    });
  }
  if (want('drawer')) {
    await page.click('.chat-drawer-open');
    await sleep(700);
    await page.locator('.chat-drawer__tab').filter({ hasText: 'Artifacts' }).click();
    await sleep(1200);
    await page.locator('.chat-drawer__artifact').first().hover();
    await sleep(500);
    await page.screenshot({ path: `${OUT}/chat-drawer.png` });
  }
  await ctx.close();
  await b.close();
}
if (want('embed')) {
  const { b, ctx, page } = await open({ w: 1280, h: 760 });
  await page.goto(
    `http://ops.localhost:17879/?src=${encodeURIComponent(`${ids.inv_url}?embed=1`)}`,
  );
  await sleep(4000);
  await page.screenshot({ path: `${OUT}/embed.png` });
  await ctx.close();
  await b.close();
}
if (want('mobile')) {
  const { b, ctx, page } = await open({ w: 390, h: 844, mobile: true });
  await page.goto(ids.pt_url);
  await sleep(3000);
  await page.click('.mns-trigger');
  await sleep(900);
  await page.screenshot({ path: `${OUT}/mobile-rail.png` });
  await page.click('.mns-trigger');
  await sleep(700);
  await page.getByText('billing docs').first().click();
  await sleep(3000);
  await page.screenshot({ path: `${OUT}/mobile-sheet.png` });
  await ctx.close();
  await b.close();
}
console.log('ok');
