import { beforeEach, describe, expect, it } from 'vitest';
import { __resetStatusBarTint, syncStatusBarTint } from './status-bar-tint';

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
  document.body.innerHTML = '';
  __resetStatusBarTint();
});

describe('the status bar tint', () => {
  it('takes the colour the TOP BAR actually painted, not a token', () => {
    // It read `--bg-chrome`, which was the same thing until the chat header
    // moved onto the list's ground (so the two views would stop looking like
    // separate products) — and on the light themes that left a pale strip
    // above a now-dark header. Measuring survives the next palette change
    // without anyone remembering this file exists.
    document.head.innerHTML = '<meta name="theme-color" content="#1e1e2e">';
    setVars({ '--bg-chrome': '#e0e0e0', '--bg': '#f8f5e2' });
    const bar = document.createElement('div');
    bar.className = 'mcl-head';
    bar.style.backgroundColor = 'rgb(0, 71, 71)';
    document.body.appendChild(bar);
    syncStatusBarTint();
    // AS HEX. iOS is the consumer and it is picky: an unparsed `theme-color`
    // is no `theme-color`, and a standalone app with none gets the system's
    // own treatment — which is how the Liquid Glass came back the moment this
    // started measuring (`getComputedStyle` returns `rgb()`, the meta had
    // always carried hex).
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#004747',
    );
    bar.remove();
  });

  it('walks up from a transparent header to the surface that IS painted', () => {
    // A header with no background of its own tells us nothing; the answer is
    // whatever it is sitting on.
    document.head.innerHTML = '<meta name="theme-color" content="#1e1e2e">';
    const ground = document.createElement('div');
    ground.style.backgroundColor = 'rgb(17, 17, 17)';
    const bar = document.createElement('div');
    bar.className = 'mobile-chat-head';
    ground.appendChild(bar);
    document.body.appendChild(ground);
    syncStatusBarTint();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#111111',
    );
    ground.remove();
  });

  it('falls back to the theme’s CHROME when no bar is mounted yet', () => {
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
  // THE COLD START IS THE REAL CASE, and it only ever took the fallback. This
  // module's first call comes from settings.ts applying the theme — at IMPORT
  // time, before React has mounted a header — and nothing measured again,
  // because a boot theme equal to the stored one applies nothing. On a light
  // theme that left exactly the pale strip the measuring was added to remove.
  // Found by review.
  it('measures the header once it appears, having started with the token', async () => {
    setVars({ '--bg-chrome': '#e0e0e0', '--bg': '#f8f5e2' });
    syncStatusBarTint();
    const meta = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;
    expect(meta()).toBe('#e0e0e0');

    // React mounts.
    const bar = document.createElement('div');
    bar.className = 'mcl-head';
    bar.style.backgroundColor = 'rgb(0, 71, 71)';
    document.body.appendChild(bar);
    await new Promise((r) => setTimeout(r, 0));
    expect(meta()).toBe('#004747');
  });

  it('stops watching once it has measured a real bar', async () => {
    const bar = document.createElement('div');
    bar.className = 'mcl-head';
    bar.style.backgroundColor = 'rgb(0, 71, 71)';
    document.body.appendChild(bar);
    syncStatusBarTint();
    const meta = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;
    expect(meta()).toBe('#004747');

    // Later DOM churn must not re-tint from some other element.
    bar.remove();
    const other = document.createElement('div');
    other.className = 'mcl-head';
    other.style.backgroundColor = 'rgb(1, 2, 3)';
    document.body.appendChild(other);
    await new Promise((r) => setTimeout(r, 0));
    expect(meta()).toBe('#004747');
  });

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
