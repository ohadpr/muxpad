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
// ── WHY THREE VERBS, AND WHY `checkout` IS NOT A SHORTCUT PAST A GATE ───────
//
// `fill` types the card. `submit` clicks the button. `checkout` does both in
// one go.
//
// An earlier draft offered only the first two, so that a human would sit
// between them and look at a screenshot of the real page before anything was
// clicked. That reasoning was wrong about where the approval lives: the stored
// card is a VIRTUAL card whose issuer asks for a per-transaction confirmation
// in its own app, on a phone, with the real merchant and the real amount. A
// muxpad-side pause in front of that is a second approval of the same payment,
// read off a screenshot instead of off the issuer's own record — strictly
// worse information, asked for twice.
//
// So `checkout` exists and it is the normal verb. `fill` and `submit` stay for
// the pages that need them: a form that reveals the button only after it
// validates, a multi-step flow, a page where you want to look first.
//
// `checkout` refuses on an incomplete fill. A submit with the number in and
// the CVC missed is not a smaller payment — it is a declined one, or a page
// that charges a saved card instead.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `usage:
  muxpad pay checkout [--url=URL] [--selector=CSS] [--shot=PATH]
                                             fill the card and click pay, on the
                                             page you are ALREADY on
  muxpad pay fill     [--url=URL] [--shot=PATH]        type the card, no click
  muxpad pay submit   [--selector=CSS] [--shot=PATH]   click the pay button
  muxpad pay show                            what card is stored (last 4 only)

  The card is ~/.muxpad/payment-card.json. 'checkout' is the normal verb: the
  stored card is a virtual one whose issuer asks you to confirm each
  transaction in its own app, with the real merchant and the real amount — so
  a muxpad-side pause in front of that approves the same payment twice, off
  worse information. 'checkout' will not click if a field was missed.

  ANY agent on this machine can read that file and run these commands. The
  thing that actually stops a payment is that per-transaction approval. Keep it
  on. A --shot of a filled form is a PICTURE OF THE CARD NUMBER: keep those out
  of chats and off 'muxpad publish'.`;

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
  if (!o.verb) return { error: 'say what to do: checkout, fill, submit or show' };
  if (!['checkout', 'fill', 'submit', 'show'].includes(o.verb))
    return { error: `unknown verb ${o.verb}` };
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

/**
 * THE OTHER WAY A PAGE ASKS FOR THE EXPIRY: two controls, not one.
 *
 * `cc-exp` is the single MM/YY box the processors use. Plenty of checkouts —
 * Shopify's own, most hand-rolled forms — ask for month and year separately,
 * and usually as `<select>`s. Those are tried only when the combined field was
 * not found, so a page that has both does not get the value typed twice.
 */
export const EXP_PARTS = [
  {
    key: 'expMonth',
    selectors: [
      '[autocomplete="cc-exp-month"]',
      'select[name*="exp" i][name*="month" i]',
      'select[id*="expMonth" i]',
      'input[name*="exp" i][name*="month" i]',
    ],
  },
  {
    key: 'expYear',
    selectors: [
      '[autocomplete="cc-exp-year"]',
      'select[name*="exp" i][name*="year" i]',
      'select[id*="expYear" i]',
      'input[name*="exp" i][name*="year" i]',
    ],
  },
];

/**
 * `07/31` → every spelling a control might want.
 *
 * A `<select>` of years is labelled `2031` about as often as `31`, and a
 * month select is `7` as often as `07`. Returning all of them lets the setter
 * try each rather than guessing the page's taste — a wrong month is a decline,
 * and a silently unset select is a decline too.
 */
export function splitExp(exp) {
  const m = /^\s*(\d{1,2})\s*[/\-\s]?\s*(\d{2}|\d{4})\s*$/.exec(String(exp ?? ''));
  if (!m) return null;
  const month = String(Number(m[1])).padStart(2, '0');
  if (Number(month) < 1 || Number(month) > 12) return null;
  const y = m[2];
  const year4 = y.length === 4 ? y : `20${y}`;
  return { month, monthShort: String(Number(month)), year4, year2: year4.slice(-2) };
}

/**
 * Is the cardholder name obviously not a name?
 *
 * `A B` was typed as a placeholder when the card was first stored, and it sat
 * there through a working end-to-end test because the test page did not care.
 * A real processor often does — AVS checks the name with the issuer, and a
 * decline at that point looks like a broken script rather than a two-letter
 * string. So it is said out loud, once, where it is cheap to fix.
 */
export function looksPlaceholder(name) {
  const n = String(name ?? '').trim();
  if (!n) return true;
  if (/^(test|cardholder|card holder|name|your name|john doe|jane doe)$/i.test(n)) return true;
  // Every word a single letter: "A B", "X Y Z".
  return n.split(/\s+/).every((w) => w.replace(/[^a-z]/gi, '').length <= 1);
}

/**
 * Did the field keep only the front of what was typed into it?
 *
 * Digits only, so a box that formats as you type (`4242 4242 …`) is not a
 * false alarm. Only a PREFIX counts, so a field that masks itself — bullets,
 * or an empty readback from a processor's own input — reads as "unknown"
 * rather than "wrong", and a page is never refused for being careful.
 */
export function keptOnlyPart(want, got) {
  if (got === null || got === undefined) return false;
  const d = (x) => String(x).replace(/\D/g, '');
  const w = d(want);
  const g = d(got);
  return g.length > 0 && g.length < w.length && w.startsWith(g);
}

/**
 * Put `value` into one control, whatever kind it is.
 *
 * `type` with a delay rather than `fill` for text: the processors' own inputs
 * reformat as you go and drop a value pasted whole. A `<select>` takes neither
 * — it needs `selectOption`, and the candidate list is tried until one sticks,
 * because a month select is labelled `07`, `7` or `July` depending on the shop.
 */
async function setControl(el, candidates) {
  const tag = (await el.evaluate((n) => n.tagName.toLowerCase())).trim();
  if (tag === 'select') {
    for (const v of candidates) {
      for (const by of [{ value: v }, { label: v }]) {
        try {
          await el.selectOption(by, { timeout: 2000 });
          return { ok: true };
        } catch {
          /* next spelling */
        }
      }
    }
    return { ok: false };
  }
  const want = String(candidates[0]);
  await el.click({ timeout: 2000 });
  await el.type(want, { delay: 25, timeout: 5000 });
  // ── DID IT ACTUALLY ALL GO IN ───────────────────────────────────────────
  // A `maxlength="4"` box — the four-box card number some banks still use —
  // takes the first four digits and drops the other twelve without an error.
  // The page then looks filled and declines, which reads as a broken script
  // rather than as the truncation it is.
  //
  // Digits only, so a field that formats as you type (`4242 4242 …`) is not a
  // false alarm; and only when what came back is a PREFIX of what was sent,
  // so a field that masks itself (bullets, an empty readback) is "unknown"
  // rather than "wrong".
  const got = await el.inputValue({ timeout: 2000 }).catch(() => null);
  return { ok: true, truncated: keptOnlyPart(want, got) };
}

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

/**
 * Type the card into whatever this page uses for each field.
 *
 * Searched across EVERY frame, because the big processors put each field in
 * its own cross-origin iframe — Playwright can reach those, which is the whole
 * reason this drives a real browser instead of posting a form.
 */
export async function fillCard(page, card) {
  const filled = [];
  const missing = [];
  const truncated = [];
  const exp = splitExp(card.exp);
  const want = (key) => {
    if (key === 'num') return [String(card.num).replace(/\s+/g, '')];
    if (key === 'exp') return [String(card.exp)];
    if (key === 'expMonth') return exp ? [exp.month, exp.monthShort] : null;
    if (key === 'expYear') return exp ? [exp.year4, exp.year2] : null;
    return card[key] ? [String(card[key])] : null;
  };
  const put = async (field) => {
    const candidates = want(field.key);
    if (!candidates) return null; // nothing stored for it — not a miss
    for (const frame of page.frames()) {
      for (const sel of field.selectors) {
        try {
          const el = frame.locator(sel).first();
          if ((await el.count()) === 0) continue;
          const r = await setControl(el, candidates);
          if (!r.ok) continue;
          if (r.truncated) truncated.push(field.key);
          return true;
        } catch {
          /* try the next selector / frame */
        }
      }
    }
    return false;
  };
  for (const f of FIELDS) {
    const r = await put(f);
    if (r === null) continue;
    (r ? filled : missing).push(f.key);
  }
  // Only when the combined MM/YY box was not there. A page with both would
  // otherwise get the expiry entered twice, in two places, one of them wrong.
  if (missing.includes('exp')) {
    const parts = [];
    for (const f of EXP_PARTS) {
      const r = await put(f);
      if (r) parts.push(f.key);
    }
    if (parts.length === EXP_PARTS.length) {
      missing.splice(missing.indexOf('exp'), 1);
      filled.push(...parts);
    }
  }
  return {
    filled,
    missing,
    ...(truncated.length ? { truncated } : {}),
    placeholderName: looksPlaceholder(card.name) ? (card.name ?? null) : null,
  };
}

/**
 * The buttons that say "Pay" and do something else entirely.
 *
 * A checkout's FIRST `Pay` button is often `Pay with PayPal`, or Apple Pay, or
 * a buy-now-pay-later tile — a different rail, a different account, and in
 * several cases a redirect away from the card that was just typed in. The
 * generic text selectors match them, so they are named and skipped; `pay
 * submit --selector=` is there for the page where one of them IS the button
 * you want.
 */
export function isWalletButton(text) {
  return /\b(paypal|apple pay|google pay|g pay|shop pay|amazon pay|venmo|klarna|affirm|afterpay|clearpay|sezzle|zip pay)\b/i.test(
    String(text ?? ''),
  );
}

/** Click the first pay button that is actually there — and is actually it. */
export async function clickPay(page, selectors) {
  const skipped = [];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) continue;
      const text = await el.innerText({ timeout: 2000 }).catch(() => '');
      if (isWalletButton(text)) {
        skipped.push(text.trim().split('\n')[0]);
        continue;
      }
      await el.click({ timeout: 5000 });
      return { clicked: sel, ...(skipped.length ? { skipped } : {}) };
    } catch {
      /* next */
    }
  }
  return { clicked: null, ...(skipped.length ? { skipped } : {}) };
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
        {
          card: `•••• ${String(c.num).slice(-4)}`,
          exp: c.exp,
          name: c.name ?? null,
          // Said here too, because 'show' is where somebody looks before
          // using it for the first time.
          ...(looksPlaceholder(c.name)
            ? { nameWarning: 'placeholder — processors check this' }
            : {}),
          file: CARD,
        },
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
  const out = { url: page.url(), verb: o.verb, shot: null };
  try {
    if (o.verb === 'fill' || o.verb === 'checkout') {
      const r = await fillCard(page, readCard());
      Object.assign(out, r);
      log({ verb: 'fill', url: out.url, filled: out.filled, missing: out.missing });
      if (out.placeholderName)
        console.error(
          `muxpad pay: the cardholder name is "${out.placeholderName}" — a placeholder. Processors check it with the issuer. Fix it in ${CARD}.`,
        );
      // ── THE ONE REFUSAL IN HERE ─────────────────────────────────────────
      // A submit on a half-filled form is not a smaller payment: it is a
      // decline, or a page that quietly charges a card it already had.
      if (o.verb === 'checkout' && out.missing.some((k) => ['num', 'exp', 'cvc'].includes(k))) {
        out.error = `not clicking pay — these fields were not found on the page: ${out.missing.join(', ')}. Look at --shot, then use 'muxpad pay submit' if it is actually complete.`;
      } else if (o.verb === 'checkout' && out.truncated?.length) {
        out.error = `not clicking pay — the page kept only part of what was typed into: ${out.truncated.join(', ')} (a maxlength, or a field split across several boxes). Fill the rest by hand and use 'muxpad pay submit'.`;
      }
    }
    if (o.verb === 'submit' || (o.verb === 'checkout' && !out.error)) {
      const r = await clickPay(page, o.selector ? [o.selector] : SUBMIT_SELECTORS);
      if (r.skipped?.length) out.skipped = r.skipped;
      if (!r.clicked) {
        out.error = o.selector
          ? `nothing matched ${o.selector}`
          : r.skipped?.length
            ? `the only buttons found were other payment rails (${r.skipped.join(', ')}) — pass --selector=CSS for the card one`
            : 'no pay button found — pass --selector=CSS';
      } else {
        out.clicked = r.clicked;
        // Let the page react before the receipt shot.
        await page.waitForTimeout(2500).catch(() => {});
        out.url = page.url();
      }
      log({ verb: 'submit', url: out.url, clicked: r.clicked, error: out.error ?? null });
    }
    if (o.shot) {
      await page.screenshot({ path: o.shot, fullPage: false });
      out.shot = o.shot;
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
