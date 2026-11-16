import { describe, expect, it } from 'vitest';
import { OUTLINE_MAX_LINES, pageOutlineExpression } from './HandbackPage.js';

/**
 * The expression runs in a browser; this runs it against a hand-built document,
 * the way MobileEmulation's probe is tested, so the DECISIONS are under test
 * even though the server project has no DOM.
 */
type Fake = Record<string, unknown>;
const el = (tagName: string, o: Fake = {}): Fake => ({
  tagName: tagName.toUpperCase(),
  type: '',
  value: '',
  textContent: '',
  disabled: false,
  checked: false,
  getAttribute: (name: string) => (o.attrs as Record<string, string> | undefined)?.[name] ?? null,
  getClientRects: () => (o.hidden ? [] : [{}]),
  ...o,
});
const read = (elements: Fake[], title = 'Checkout', href = 'https://shop.example/pay') => {
  const doc = { title, querySelectorAll: () => elements };
  const loc = { href };
  return new Function('document', 'location', `return ${pageOutlineExpression()}`)(doc, loc) as {
    url: string;
    title: string;
    outline: string[];
  };
};

describe('the page an agent is handed back', () => {
  it('says where it is and what is on it', () => {
    const page = read([
      el('h1', { textContent: 'Review your order' }),
      el('button', { textContent: 'Pay $107.26', disabled: true }),
      el('a', { textContent: 'Terms' }),
      el('iframe', { src: 'https://challenges.cloudflare.com/turnstile/x' }),
    ]);
    expect(page.url).toBe('https://shop.example/pay');
    expect(page.title).toBe('Checkout');
    expect(page.outline).toEqual([
      'heading: Review your order',
      'button: Pay $107.26 (disabled)',
      'link: Terms',
      'frame: challenges.cloudflare.com',
    ]);
  });

  it('NEVER carries what a person typed — only whether a field is filled', () => {
    // A person has just been on this page. What they typed is very often a
    // card number, and this text lands in a transcript.
    const page = read([
      el('input', {
        type: 'text',
        value: '4242424242424242',
        labels: [{ textContent: 'Card number' }],
      }),
      el('input', { type: 'password', value: 'hunter2', placeholder: 'Password' }),
      el('input', { type: 'text', value: '', name: 'cvc' }),
      el('input', { type: 'checkbox', checked: true, attrs: { 'aria-label': 'I agree' } }),
      el('select', { selectedIndex: 3, name: 'state' }),
    ]);
    const all = JSON.stringify(page);
    expect(all).not.toContain('4242');
    expect(all).not.toContain('hunter2');
    expect(page.outline).toEqual([
      'field "Card number": filled',
      'field "Password": filled',
      'field "cvc": empty',
      'checkbox "I agree": checked',
      'field "state": filled',
    ]);
  });

  it('leaves out what is not on screen, and hidden fields', () => {
    const page = read([
      el('button', { textContent: 'Secret admin', hidden: true }),
      el('input', { type: 'hidden', value: 'csrf' }),
      el('button', { textContent: 'Continue' }),
    ]);
    expect(page.outline).toEqual(['button: Continue']);
  });

  it('is bounded, however big the page', () => {
    const many = Array.from({ length: 200 }, (_, i) => el('a', { textContent: `link ${i}` }));
    const page = read(many);
    expect(page.outline.length).toBe(OUTLINE_MAX_LINES + 1);
    expect(page.outline.at(-1)).toBe('…');
    const long = read([el('h2', { textContent: 'x'.repeat(500) })]);
    expect(long.outline[0]?.length).toBeLessThanOrEqual('heading: '.length + 80);
  });

  it('answers with an empty outline rather than throwing on a page it cannot read', () => {
    const doc = {
      title: 'odd',
      querySelectorAll: () => {
        throw new Error('cross-origin');
      },
    };
    const page = new Function('document', 'location', `return ${pageOutlineExpression()}`)(doc, {
      href: 'https://x.example/',
    });
    expect(page).toEqual({ url: 'https://x.example/', title: 'odd', outline: [] });
  });
});
