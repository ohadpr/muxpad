import { beforeEach, describe, expect, it } from 'vitest';
import { syncStatusBarTint } from './status-bar-tint';

/**
 * The status bar is now OPAQUE and tinted by `theme-color` — that is the whole
 * point of dropping `apple-mobile-web-app-status-bar-style`, which on iOS 26
 * earned a system Liquid Glass blur over the top of the page. A constant
 * `theme-color` was fine for one dark palette and is wrong for eleven themes:
 * a cream app under a `#1e1e2e` bar reads as a rendering fault.
 */
const setVars = (vars: Record<string, string>) => {
  const el = document.documentElement;
  el.style.cssText = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.documentElement.style.cssText = '';
});

describe('the status bar tint', () => {
  it('follows the theme’s CHROME, which is what the bar actually sits above', () => {
    // Not `--bg`: the status bar's neighbour is the app's top bar (the chat
    // header, the list header), so matching the chrome is what makes the seam
    // disappear.
    document.head.innerHTML = '<meta name="theme-color" content="#1e1e2e">';
    setVars({ '--bg-chrome': '#e0e0e0', '--bg': '#f8f5e2' });
    syncStatusBarTint();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#e0e0e0',
    );
  });

  it('falls back to the page background for a theme with no chrome colour', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#1e1e2e">';
    setVars({ '--bg': '#101014' });
    syncStatusBarTint();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#101014',
    );
  });

  it('creates the tag when the document has none', () => {
    setVars({ '--bg-chrome': '#ffffff' });
    syncStatusBarTint();
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#ffffff',
    );
  });

  it('never leaves the bar unpainted', () => {
    // Last resort only: a theme that sets neither variable would otherwise
    // hand iOS an empty string, and an empty `theme-color` is not "default",
    // it is invalid.
    syncStatusBarTint();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#000000',
    );
  });

  it('rewrites the tag when the theme changes, not just the first time', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#1e1e2e">';
    setVars({ '--bg-chrome': '#e0e0e0' });
    syncStatusBarTint();
    setVars({ '--bg-chrome': '#004747' });
    syncStatusBarTint();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#004747',
    );
  });
});

describe('the meta that must NOT come back', () => {
  it('is documented in index.html rather than left to memory', async () => {
    // A regression here is invisible in every browser we can test with — the
    // blur only exists in the installed app on a real phone — so the guard is
    // that the tag stays absent and the reason stays written down.
    // `import.meta.url` is an http:// URL under the jsdom/vite runner, so the
    // path is resolved from the project root instead.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).not.toMatch(/<meta\s+name="apple-mobile-web-app-status-bar-style"/);
    expect(html).toContain('Liquid Glass');
  });
});
