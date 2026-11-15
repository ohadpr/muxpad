import { describe, expect, it } from 'vitest';
import {
  EXP_PARTS,
  FIELDS,
  SUBMIT_SELECTORS,
  cdpUrl,
  clickPay,
  isWalletButton,
  keptOnlyPart,
  parseArgs,
  splitExp,
} from '../../scripts/browser-pay.mjs';

/**
 * `muxpad pay` — the argument surface and the selector tables.
 *
 * The browser half is proven by running it against a real checkout page (a
 * cross-document CVC frame included); what is worth pinning here is the part
 * that decides WHAT HAPPENS: a verb that submits when you asked it to fill is
 * the one bug in this file that costs money.
 */
describe('muxpad pay arguments', () => {
  it('refuses a verb it does not know rather than guessing', () => {
    expect(parseArgs(['send']).error).toMatch(/unknown verb/);
    expect(parseArgs(['pay']).error).toMatch(/unknown verb/);
    expect(parseArgs([]).error).toMatch(/say what to do/);
    expect(parseArgs(['fill', 'submit']).error).toMatch(/one verb/);
  });

  it('keeps fill and submit apart — they are different amounts of money', () => {
    expect(parseArgs(['fill']).verb).toBe('fill');
    expect(parseArgs(['submit']).verb).toBe('submit');
    // No flag can turn one into the other.
    expect(parseArgs(['fill', '--selector=button']).verb).toBe('fill');
  });

  it('has a verb that does both, and it is spelled out', () => {
    // `checkout` fills AND clicks, because the approval that matters is the
    // issuer's own per-transaction one, in its app, with the real amount. A
    // muxpad-side pause in front of that approves the same payment twice.
    expect(parseArgs(['checkout']).verb).toBe('checkout');
    expect(parseArgs(['checkout', '--url=https://s/c', '--selector=#go']).verb).toBe('checkout');
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // A typo'd `--amount=5` silently dropped would read as "it accepted my
    // cap". There is no cap; the flag must be refused out loud.
    expect(parseArgs(['submit', '--amount=5']).error).toMatch(/unknown flag/);
    expect(parseArgs(['fill', '--yolo']).error).toMatch(/unknown flag/);
  });

  it('takes a url and a screenshot path', () => {
    const o = parseArgs(['fill', '--url=https://shop.example/checkout', '--shot=/tmp/a.png']);
    expect(o.url).toBe('https://shop.example/checkout');
    expect(o.shot).toBe('/tmp/a.png');
  });
});

describe('the field tables', () => {
  it('leads every field with its autocomplete attribute', () => {
    // The standard the processors actually set. The name/id guesses after it
    // are for hand-rolled forms; leading with a guess would fill the wrong
    // box on a page that did it properly.
    for (const f of FIELDS) expect(f.selectors[0], f.key).toMatch(/^input\[autocomplete=/);
  });

  it('covers the five a checkout asks for', () => {
    expect(FIELDS.map((f) => f.key)).toEqual(['num', 'exp', 'cvc', 'name', 'zip']);
  });

  it('finds the pay button by its WORDS, not a class name', () => {
    // Class names are per-site and change; "Pay"/"Place order" is the button
    // a person would click.
    for (const s of SUBMIT_SELECTORS) expect(s).toMatch(/has-text/);
  });
});

describe('the browser it talks to', () => {
  it('is this chat own session browser, never a new one', () => {
    expect(cdpUrl({ MUXPAD_TAB_ID: 'T1', MUXPAD_API_URL: 'http://127.0.0.1:7777' })).toBe(
      'http://127.0.0.1:7777/api/browsers/s-T1/cdp',
    );
  });

  it('answers null outside a pane rather than guessing an endpoint', () => {
    expect(cdpUrl({})).toBeNull();
  });
});

describe('the expiry, which pages ask for in two different shapes', () => {
  it('splits MM/YY into every spelling a control might want', () => {
    // A year `<select>` is labelled 2031 about as often as 31, and a month one
    // is 7 as often as 07. Guessing one gets a silent non-selection, which is
    // a decline that looks like a working script.
    expect(splitExp('07/31')).toEqual({
      month: '07',
      monthShort: '7',
      year4: '2031',
      year2: '31',
    });
    expect(splitExp('7/2031')?.month).toBe('07');
    expect(splitExp('12 29')?.year4).toBe('2029');
  });

  it('answers null for something that is not a date, rather than a wrong one', () => {
    for (const bad of ['', 'soon', '13/29', '00/29', '7', undefined])
      expect(splitExp(bad), String(bad)).toBeNull();
  });

  it('keeps the split pair out of the main table', () => {
    // FIELDS is what a page is scanned for FIRST; the pair is a fallback used
    // only when the combined box is absent, or a form with both gets the
    // expiry typed into two places.
    expect(FIELDS.map((f) => f.key)).not.toContain('expMonth');
    expect(EXP_PARTS.map((f) => f.key)).toEqual(['expMonth', 'expYear']);
    // Selects, not inputs — that is the shape this exists for.
    expect(EXP_PARTS.some((f) => f.selectors.some((s) => s.startsWith('select')))).toBe(true);
  });
});

describe('a field that silently kept only part of what was typed', () => {
  it('catches the maxlength truncation that reads as a mystery decline', () => {
    // The four-box card number some banks still use: box one takes four
    // digits and drops the other twelve with no error at all, so the page
    // looks filled and the payment declines.
    expect(keptOnlyPart('4242424242424242', '4242')).toBe(true);
    expect(keptOnlyPart('0731', '07')).toBe(true);
  });

  it('is not fooled by a field that formats as you type', () => {
    // Stripe's own input spaces the number out. Digits only, so this is the
    // same value, not a truncated one.
    expect(keptOnlyPart('4242424242424242', '4242 4242 4242 4242')).toBe(false);
    expect(keptOnlyPart('0731', '07 / 31')).toBe(false);
  });

  it('treats a masked or unreadable field as unknown, never as wrong', () => {
    // A refusal has to be worth something. A processor input that reads back
    // as bullets, or not at all, is not evidence of a problem — and refusing
    // on it would make `checkout` useless on exactly the pages it is for.
    for (const got of ['••••', '', null, undefined])
      expect(keptOnlyPart('4242424242424242', got), JSON.stringify(got)).toBe(false);
    // Different digits entirely: something else is going on, and it is not
    // this check's business to guess.
    expect(keptOnlyPart('4242424242424242', '1111')).toBe(false);
  });
});

describe('the button it clicks', () => {
  it('skips the other payment rails, which also say "Pay"', () => {
    // A checkout's first Pay button is often PayPal's — a different account,
    // usually a redirect, and nothing to do with the card just typed in.
    for (const t of ['Pay with PayPal', 'Apple Pay', 'G Pay', 'Pay in 4 with Klarna'])
      expect(isWalletButton(t), t).toBe(true);
  });

  it('does not refuse the real one for containing the word pay', () => {
    for (const t of ['Pay $12.34', 'Place order', 'Pay now', 'Confirm payment', '', null])
      expect(isWalletButton(t), String(t)).toBe(false);
  });
});

/**
 * clickPay against a fake page — nine lines of duck typing instead of a
 * browser, because what is being checked is the DECISION, not Playwright.
 */
function fakePage(buttons: Record<string, string>) {
  const clicks: string[] = [];
  return {
    clicks,
    locator: (sel: string) => ({
      first: () => ({
        count: async () => (sel in buttons ? 1 : 0),
        innerText: async () => buttons[sel] ?? '',
        click: async () => {
          clicks.push(sel);
        },
      }),
    }),
  };
}

describe('choosing which button to click', () => {
  it('walks past a wallet button to the real one', async () => {
    const page = fakePage({
      'button[type="submit"]:has-text("Pay")': 'Pay with PayPal',
      'button:has-text("Place order")': 'Place order',
    });
    const r = await clickPay(page, [
      'button[type="submit"]:has-text("Pay")',
      'button:has-text("Place order")',
    ]);
    expect(r.clicked).toBe('button:has-text("Place order")');
    expect(r.skipped).toEqual(['Pay with PayPal']);
    expect(page.clicks).toEqual(['button:has-text("Place order")']);
  });

  it('clicks NOTHING when every candidate is another rail', async () => {
    const page = fakePage({ 'button:has-text("Pay")': 'Pay with PayPal' });
    const r = await clickPay(page, ['button:has-text("Pay")']);
    expect(r.clicked).toBeNull();
    expect(page.clicks).toEqual([]);
  });

  it('obeys an explicit --selector even when it IS a wallet', async () => {
    // The filter is a guess about which of several buttons was meant. A guess
    // must not override an instruction — `--selector` is how you say "yes,
    // that PayPal button, I mean it".
    const page = fakePage({ '#paypal': 'Pay with PayPal' });
    const r = await clickPay(page, ['#paypal'], { explicit: true });
    expect(r.clicked).toBe('#paypal');
    expect(page.clicks).toEqual(['#paypal']);
  });
});
