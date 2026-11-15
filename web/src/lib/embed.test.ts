import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { embedRequested, shellChrome } from './embed';

describe('embedRequested', () => {
  it('is on only for the exact flag', () => {
    expect(embedRequested('?embed=1')).toBe(true);
    expect(embedRequested('?pane=p1&embed=1')).toBe(true);
  });

  it('is off for everything else, including the near misses', () => {
    // `embed` alone and `embed=true` are the two a person would type by
    // accident. Neither turns the chrome off, so a mistyped url behaves like
    // an ordinary one rather than half-applying the mode.
    for (const s of ['', '?', '?pane=p1', '?embed', '?embed=0', '?embed=true', '?embedded=1'])
      expect(embedRequested(s), JSON.stringify(s)).toBe(false);
  });
});

describe('shellChrome', () => {
  const chrome = (over: Partial<Parameters<typeof shellChrome>[0]> = {}) =>
    shellChrome({ isMobile: false, inWorkspace: true, embedded: false, ...over });

  it('an embed shows neither sidebar nor top bar', () => {
    // Both, because they are not independent: turning the sidebar off is what
    // normally brings the top bar back, so checking the embed in one place
    // would have swapped one piece of chrome for another.
    expect(chrome({ embedded: true })).toEqual({ sidebar: false, topBar: false });
    expect(chrome({ embedded: true, isMobile: true })).toEqual({ sidebar: false, topBar: false });
    expect(chrome({ embedded: true, inWorkspace: false })).toEqual({
      sidebar: false,
      topBar: false,
    });
  });

  it('leaves the cockpit exactly as it was', () => {
    // Desktop in a workspace: the sidebar absorbs the bar.
    expect(chrome()).toEqual({ sidebar: true, topBar: false });
    // Desktop on the workspace picker: no sidebar to absorb it.
    expect(chrome({ inWorkspace: false })).toEqual({ sidebar: true, topBar: true });
    // Mobile: never a sidebar, always the bar.
    expect(chrome({ isMobile: true })).toEqual({ sidebar: false, topBar: true });
  });
});

describe('the CLI and the client agree on the flag', () => {
  it('emits a url this module recognises as an embed', () => {
    // The conformance this repo keeps paying for when it is missing: the
    // shell prints a url, the client parses it, and nothing connects the two
    // but a string. `?embed=true` in one half and `=1` in the other would
    // hand over a url that renders the full cockpit inside somebody's app.
    const cli = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'muxpad'), 'utf8');
    const fn = cli.slice(cli.indexOf('cmd_embed() {'));
    const params = [...fn.slice(0, fn.indexOf('\n}\n')).matchAll(/\?(embed=[^"'\s]*)/g)].map(
      (m) => m[1],
    );
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) expect(embedRequested(`?${p}`), p).toBe(true);
  });
});

describe('the flag survives the router', () => {
  it('is kept by the tab route, which drops every param it does not list', () => {
    // THE BUG: TabView rewrites the search on mount to reflect the active
    // pane, and `validateSearch` drops anything unlisted. So `?embed=1` lived
    // until the first render and any RELOAD of the iframe came back as the
    // full cockpit — sidebar and all — inside somebody else's app. The boot
    // latch in this module is why the first paint was always right, which is
    // exactly what made it hard to see.
    const src = readFileSync(join(__dirname, '..', 'router.tsx'), 'utf8');
    const tabRoute = src.slice(src.indexOf('const tabRoute'));
    const validate = tabRoute.slice(0, tabRoute.indexOf('component:'));
    expect(validate).toMatch(/embed:\s*search\.embed === '1' \? '1' : undefined/);
    // And the type has to carry it, or the object is silently narrowed away.
    expect(validate).toMatch(/embed\?:\s*'1' \| undefined/);
  });
});

describe('AppLayout actually consults it', () => {
  // `shellChrome` and `isEmbedded` were tested in isolation, and the wiring
  // between them and the component was not — so deleting the call from
  // AppLayout left every test here green while the embed rendered the full
  // cockpit. AppLayout needs a router, a settings provider and a tab list to
  // mount, so this reads the source; comments are stripped first, because the
  // lines being asserted sit under a comment that names them.
  const src = readFileSync(join(__dirname, '..', 'components', 'AppLayout.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('asks isEmbedded and feeds it to shellChrome', () => {
    expect(src).toMatch(/const embedded = isEmbedded\(\)/);
    expect(src).toMatch(/shellChrome\(\{[^}]*embedded[^}]*\}\)/);
  });

  it('uses BOTH halves of the answer, not just the sidebar', () => {
    // Turning the sidebar off is what normally brings the top bar back, so a
    // component that read only `chrome.sidebar` would swap one piece of
    // chrome for another.
    expect(src).toMatch(/=\s*chrome\.sidebar/);
    expect(src).toMatch(/=\s*chrome\.topBar/);
  });
});
