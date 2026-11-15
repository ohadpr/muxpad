#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
// `muxpad pay` — put the stored card into the checkout page you are already
// on, show you what it looks like, and submit only after you have said so.
//
// ── THE HONEST SECURITY STORY, IN ONE PARAGRAPH ─────────────────────────────
//
// The card lives at ~/.muxpad/payment-card.json, mode 600, owned by you — and
// every agent on this machine RUNS as you. So any of them can read it, and any
// of them could drive a browser and spend it. Nothing in this file changes
// that, and an earlier draft that claimed "the agent never sees the digits"
// was simply false. What actually stops a bad payment is the card issuer's own
// per-transaction approval on your phone. Everything here is convenience and a
// record; the gate is at the bank.
//
// That is also why there is no spend cap here. A ceiling enforced by a file
// next to the card, by code any agent can edit, is a number that feels like a
// control and is not one.
//
// ── WHY TWO VERBS ───────────────────────────────────────────────────────────
//
// `fill` types the card and screenshots the page. `submit` clicks the button.
// They are separate so a HUMAN sits between them, looking at the screenshot of
// the real page with the real total, rather than reading an amount the agent
// told them. The picture is the approval: it cannot be out of date or
// mis-parsed the way a scraped number can.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `usage:
  muxpad pay fill   [--url=URL] [--shot=PATH]
                                             type the stored card into the page
                                             you are ALREADY on (or --url=),
                                             then screenshot
  muxpad pay submit [--selector=CSS] [--shot=PATH]
                                             click the pay button
  muxpad pay show                            what card is stored (last 4 only)

  The card is ~/.muxpad/payment-card.json. 'fill' never submits; 'submit'
  never fills. Look at the screenshot between them — that is the approval, and
  it is a picture of the real page with the real total.

  ANY agent on this machine can read that file and run these commands. The
  thing that actually stops a payment is your card issuer's per-transaction
  approval. Keep it on.`;

/** Where the card lives. One place, named once. */
const CARD = join(homedir(), '.muxpad', 'payment-card.json');
/** Every fill and submit, appended. A record, not a control. */
const LEDGER = join(homedir(), '.muxpad', 'payment-log.jsonl');

export function parseArgs(argv) {
  const o = { verb: null, shot: null, selector: null, url: null, timeoutMs: 20000 };
  for (const a of argv) {
    if (a === '-h' || a === '--help') return { help: true };
    const m = /^--([a-z]+)=(.*)$/s.exec(a);
    if (!m) {
      if (a.startsWith('--')) return { error: `unknown flag ${a}` };
      if (o.verb) return { error: `one verb at a time (got ${o.verb} and ${a})` };
      o.verb = a;
      continue;
    }
    const [, k, v] = m;
    if (k === 'shot') o.shot = v;
    else if (k === 'url') o.url = v;
    else if (k === 'selector') o.selector = v;
    else if (k === 'timeout') o.timeoutMs = Math.max(1, Number(v) || 20) * 1000;
    else return { error: `unknown flag --${k}` };
  }
  if (!o.verb) return { error: 'say what to do: fill, submit or show' };
  if (!['fill', 'submit', 'show'].includes(o.verb)) return { error: `unknown verb ${o.verb}` };
  return o;
}

export function readCard(path = CARD) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `no card at ${path} — write one with the snippet in docs/connectors.md, or run 'muxpad pay show'`,
    );
  }
  const c = JSON.parse(raw);
  for (const k of ['num', 'exp', 'cvc']) if (!c[k]) throw new Error(`the card file has no ${k}`);
  return c;
}

/**
 * The fields a checkout asks for, and every way a page might name them.
 *
 * `autocomplete` first because it is the standard and Stripe/Adyen/Braintree
 * all set it; the name/id/placeholder guesses are for the hand-rolled forms
 * that do not. Searched across EVERY frame, because the big processors put
 * each field in its own cross-origin iframe — Playwright can reach those,
 * which is the whole reason this drives a real browser rather than posting a
 * form.
 */
export const FIELDS = [
  {
    key: 'num',
    selectors: [
      'input[autocomplete="cc-number"]',
      'input[name*="cardnumber" i]',
      'input[name*="card_number" i]',
      'input[id*="cardnumber" i]',
      'input[placeholder*="card number" i]',
      'input[aria-label*="card number" i]',
    ],
  },
  {
    key: 'exp',
    selectors: [
      'input[autocomplete="cc-exp"]',
      'input[name*="exp" i]',
      'input[id*="exp" i]',
      'input[placeholder*="MM" i]',
      'input[aria-label*="expiration" i]',
    ],
  },
  {
    key: 'cvc',
    selectors: [
      'input[autocomplete="cc-csc"]',
      'input[name*="cvc" i]',
      'input[name*="cvv" i]',
      'input[id*="cvc" i]',
      'input[placeholder*="CVC" i]',
      'input[aria-label*="security code" i]',
    ],
  },
  {
    key: 'name',
    selectors: ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]'],
  },
  {
    key: 'zip',
    selectors: [
      'input[autocomplete="postal-code"]',
      'input[name*="postal" i]',
      'input[name*="zip" i]',
    ],
  },
];

/** The pay button, when you have not named one. Text, not class names. */
export const SUBMIT_SELECTORS = [
  'button[type="submit"]:has-text("Pay")',
  'button:has-text("Place order")',
  'button:has-text("Complete")',
  'button:has-text("Confirm")',
  'button:has-text("Buy")',
];

export function cdpUrl(env) {
  const tab = env.MUXPAD_TAB_ID;
  if (!tab) return null;
  const base = (env.MUXPAD_API_URL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
  return `${base}/api/browsers/s-${encodeURIComponent(tab)}/cdp`;
}

/** Append one line. Best-effort: a missing record must never stop a payment. */
function log(entry) {
  try {
    appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* a ledger is a record of a payment, never a precondition for one */
  }
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) return void console.log(USAGE);
  if (o.error) {
    console.error(`muxpad pay: ${o.error}\n\n${USAGE}`);
    return 1;
  }
  if (o.verb === 'show') {
    const c = readCard();
    console.log(
      JSON.stringify(
        { card: `•••• ${String(c.num).slice(-4)}`, exp: c.exp, name: c.name ?? null, file: CARD },
        null,
        2,
      ),
    );
    return 0;
  }

  const endpoint = cdpUrl(process.env);
  if (!endpoint) {
    console.error('muxpad pay: no MUXPAD_TAB_ID — run it from inside a muxpad pane');
    return 1;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { chromium } = createRequire(join(root, 'server', 'package.json'))('playwright');
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: o.timeoutMs });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/409/.test(msg))
      console.error(
        'muxpad pay: a person has this browser right now — wait for them to hand it back',
      );
    else console.error(`muxpad pay: could not reach the muxpad browser: ${msg.split('\n')[0]}`);
    return 1;
  }
  const ctx = browser.contexts()[0];
  // THE PAGE YOU ARE ALREADY ON — never a new one. `probe` opens a tab per
  // call, which is right for asking a question and wrong for a checkout: the
  // basket, the session and the shipping step all live on the open page.
  // BLANK PAGES ARE NOT THE CHECKOUT. `muxpad browser probe` opens a tab,
  // answers, and closes it — leaving an `about:blank` behind as the newest
  // page. Picking that one filled a card into nothing and reported every
  // field missing, which is how this was found.
  const pages = (ctx?.pages?.() ?? []).filter((p) => {
    const u = p.url();
    return u && u !== 'about:blank' && !u.startsWith('chrome://');
  });
  let page = pages[pages.length - 1];
  if (o.url) {
    // Asked for explicitly: a checkout you can reach by url, with no cart
    // flow in front of it. Reuses an open page rather than piling up tabs.
    page = page ?? (await ctx.newPage());
    await page.goto(o.url, { timeout: o.timeoutMs, waitUntil: 'load' });
  }
  if (!page) {
    console.error(
      'muxpad pay: this browser has no page open on a checkout — navigate there first (the Playwright MCP keeps its page; `browser probe` does not), or pass --url=',
    );
    await browser.close();
    return 1;
  }
  const out = { url: page.url(), verb: o.verb, filled: [], missing: [], shot: null };
  try {
    if (o.verb === 'fill') {
      const card = readCard();
      for (const f of FIELDS) {
        const value = card[f.key];
        if (!value) continue;
        let done = false;
        for (const frame of page.frames()) {
          for (const sel of f.selectors) {
            try {
              const el = frame.locator(sel).first();
              if ((await el.count()) === 0) continue;
              // `type` with a small delay, not `fill`: the processors' own
              // inputs reformat as you go and drop a value pasted whole.
              await el.click({ timeout: 2000 });
              await el.type(String(value), { delay: 25, timeout: 5000 });
              out.filled.push(f.key);
              done = true;
              break;
            } catch {
              /* try the next selector / frame */
            }
          }
          if (done) break;
        }
        if (!done) out.missing.push(f.key);
      }
      log({ verb: 'fill', url: out.url, filled: out.filled, missing: out.missing });
    } else {
      const sels = o.selector ? [o.selector] : SUBMIT_SELECTORS;
      let clicked = null;
      for (const sel of sels) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) === 0) continue;
          await el.click({ timeout: 5000 });
          clicked = sel;
          break;
        } catch {
          /* next */
        }
      }
      if (!clicked) {
        out.error = o.selector
          ? `nothing matched ${o.selector}`
          : 'no pay button found — pass --selector=CSS';
      } else {
        out.clicked = clicked;
        // Let the page react before the receipt shot.
        await page.waitForTimeout(2500).catch(() => {});
        out.url = page.url();
      }
      log({ verb: 'submit', url: out.url, clicked, error: out.error ?? null });
    }
    if (o.shot) {
      await page.screenshot({ path: o.shot, fullPage: false });
      out.shot = o.shot;
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(JSON.stringify(out, null, 2));
  return out.error ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()))
  main(process.argv.slice(2)).then((c) => process.exit(c ?? 0));
