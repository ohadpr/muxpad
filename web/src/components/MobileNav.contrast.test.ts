import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE BAR UNDER A CHAT TAKES THE PAGE'S PALETTE, NOT THE RAIL'S.
 *
 * "Bottom bar colour scheme in chat view is not good in some themes."
 *
 * `.mcl-tabs` mixes its ground from `--rail-ink` over `--rail-surface`, which
 * is right on the chat LIST: the list sits on the rail island, so the bar's
 * labels inherit the rail's ink and ground and ink agree. Under a CHAT there
 * is no island — the labels inherit the page's `--fg` — so a rail-mixed
 * ground put dark text on a dark plate wherever the two families diverge.
 *
 * NOT IN themes.test.ts, and that is the honest part. That sweep models two
 * surfaces, `rail` and `phone`, and BOTH are island contexts that rebind the
 * ink tokens to the rail's. Adding the chat bar there made it resolve
 * `--fg-dim` to the rail's light ink over a light page and fail at 1.49:1 —
 * a true statement about a scope the element is never in. Faking a third
 * surface to make it pass would have been worse than not testing it, so what
 * is pinned here is the PROPERTY: the chat variant derives from the page's
 * pair. Verified live on memphis at #e8e5df ground with rgb(18,16,22) ink.
 */
const css = readFileSync(join(__dirname, 'MobileNav.css'), 'utf8');
const rule = /\.mcl-tabs\.-onchat\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

describe('the chat view’s tab bar', () => {
  it('mixes its ground from the page, not the rail', () => {
    expect(rule).toMatch(/--bg-elev:\s*color-mix\([^)]*var\(--fg\)[^)]*var\(--bg\)/);
    expect(rule).not.toMatch(/--rail-/);
  });

  it('uses the same lift as the list’s bar, not a second design', () => {
    // The point is one object in two places, not two bars. If these drift,
    // the phone grows a second kind of tab bar nobody designed.
    const base = /\.mcl-tabs\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const pct = (s: string) => /var\(--(?:fg|rail-ink)\)\s+(\d+)%/.exec(s)?.[1];
    expect(pct(rule)).toBe(pct(base));
  });

  it('still paints a ground at all', () => {
    expect(rule).toMatch(/background:\s*var\(--bg-elev\)/);
  });
});
