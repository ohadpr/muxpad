// Record the tour: send the pricing request, watch sub-chats spawn, open the
// drawer, click into one, close it, and see the reports and action cards land.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { open, sleep } from './lib.mjs';
const ids = Object.fromEntries(
  (await import('node:fs'))
    .readFileSync('/private/tmp/mxd/ids.sh', 'utf8')
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((s) => s.split('=').map((x) => x.trim()))
    .map(([k, ...v]) => [k, v.join('=')]),
);
const OUT = '/private/tmp/mxd/frames';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const { b, ctx, page } = await open({ w: 1000, h: 700, scale: 2 });
for (const k of ['oauth_url', 'rep_url', 'sw_url', 'sl_url']) {
  await page.goto(ids[k]);
  await sleep(1500);
}
await page.goto(ids.pt_url);
await sleep(3000);
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async (f) => {
  const n = frames.length;
  writeFileSync(`${OUT}/${String(n).padStart(4, '0')}.png`, Buffer.from(f.data, 'base64'));
  frames.push({ n, t: f.metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
const t0 = Date.now();
const marks = { typing: Date.now() / 1000 + 0.9 };
const mark = (s) => console.log(((Date.now() - t0) / 1000).toFixed(1), s);
await cdp.send('Page.startScreencast', {
  format: 'png',
  maxWidth: 2000,
  maxHeight: 1400,
  everyNthFrame: 1,
});
await sleep(900);
const box = page.locator('.chat-input').first();
await box.click();
await box.pressSequentially('Price them out, and dig into the ones with no seat minimum.', {
  delay: 22,
});
await sleep(250);
await page.keyboard.press('Enter');
mark('sent');
marks.sent = Date.now() / 1000;
await sleep(Number(process.env.T_DRAWER ?? 5200));
await page.click('.chat-drawer-open');
mark('drawer');
await sleep(1300);
await page.locator('.chat-drawer').getByText('trellis deep dive').first().click();
mark('trellis');
await sleep(Number(process.env.T_WATCH ?? 4700));
await page.click('.chat-drawer__close');
mark('closed');
await sleep(Number(process.env.T_END ?? 6000));
mark('end');
await cdp.send('Page.stopScreencast');
await sleep(300);
writeFileSync(`${OUT}/frames.json`, JSON.stringify({ frames, marks }));
console.log('frames', frames.length);
await ctx.close();
await b.close();
