import { describe, expect, it } from 'vitest';
import { FIELDS, SUBMIT_SELECTORS, cdpUrl, parseArgs } from '../../scripts/browser-pay.mjs';

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
    expect(parseArgs([]).error).toMatch(/say what to do/);
    expect(parseArgs(['fill', 'submit']).error).toMatch(/one verb/);
  });

  it('keeps fill and submit apart — they are different amounts of money', () => {
    expect(parseArgs(['fill']).verb).toBe('fill');
    expect(parseArgs(['submit']).verb).toBe('submit');
    // No flag can turn one into the other.
    expect(parseArgs(['fill', '--selector=button']).verb).toBe('fill');
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
