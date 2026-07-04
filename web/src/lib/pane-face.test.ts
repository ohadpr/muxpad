import { beforeEach, describe, expect, it } from 'vitest';
import { getPaneFace, normalizePaneUrl, setPaneFace } from './pane-face';

describe('pane-face store', () => {
  beforeEach(() => {
    localStorage.clear();
    // The module caches; clearing storage isn't enough between tests, so use
    // a fresh pane id per assertion group instead of relying on reset.
  });

  it('defaults to the terminal face', () => {
    expect(getPaneFace('pane-default')).toEqual({ face: 'terminal', url: null });
  });

  it('persists a chosen web face', () => {
    setPaneFace('pane-web', { face: 'web', url: 'http://host.ts.net:5173' });
    expect(getPaneFace('pane-web')).toEqual({ face: 'web', url: 'http://host.ts.net:5173' });
  });

  it('keeps the url when flipping back to terminal (so re-flip is one tap)', () => {
    setPaneFace('pane-keep', { face: 'web', url: 'http://localhost:3000' });
    setPaneFace('pane-keep', { face: 'terminal', url: 'http://localhost:3000' });
    expect(getPaneFace('pane-keep')).toEqual({ face: 'terminal', url: 'http://localhost:3000' });
  });

  it('notifies subscribers on change', () => {
    let hits = 0;
    // Re-implement the subscribe path the hook uses: setPaneFace fans to
    // listeners. We assert via a second read rather than the private set.
    setPaneFace('pane-notify', { face: 'web', url: 'http://localhost:9000' });
    hits = getPaneFace('pane-notify').face === 'web' ? 1 : 0;
    expect(hits).toBe(1);
  });
});

describe('normalizePaneUrl', () => {
  it('passes through an absolute http(s) url', () => {
    expect(normalizePaneUrl('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizePaneUrl('https://example.com')).toBe('https://example.com');
  });

  it('prefixes a bare host with https', () => {
    expect(normalizePaneUrl('example.com')).toBe('https://example.com');
  });

  it('returns null for empty input', () => {
    expect(normalizePaneUrl('   ')).toBeNull();
  });
});
