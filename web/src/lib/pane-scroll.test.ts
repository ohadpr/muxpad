import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPaneForegroundCmd,
  getPaneScrollRatio,
  rememberPaneForegroundCmd,
  setPaneScrollRatio,
  stickyForegroundCmd,
} from './pane-scroll';

describe('pane-scroll', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips scroll ratio per pane', () => {
    setPaneScrollRatio('pane-a', 0.42);
    expect(getPaneScrollRatio('pane-a')).toBe(0.42);
    expect(getPaneScrollRatio('pane-b')).toBeUndefined();
  });

  it('clamps ratio to 0..1', () => {
    setPaneScrollRatio('pane-a', -0.5);
    expect(getPaneScrollRatio('pane-a')).toBe(0);
    setPaneScrollRatio('pane-a', 2);
    expect(getPaneScrollRatio('pane-a')).toBe(1);
  });

  it('ignores legacy absolute offsets from v1 storage', () => {
    localStorage.setItem('muxpad.paneScroll.v1', JSON.stringify({ 'pane-a': 500 }));
    expect(getPaneScrollRatio('pane-a')).toBeUndefined();
  });
});

describe('last-known foreground cmd (decoratePane reports null after a main-server restart)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('remembers a live cmd and returns it when the next decoration is null', () => {
    expect(stickyForegroundCmd('p1', 'node claude-code')).toBe('node claude-code');
    expect(getPaneForegroundCmd('p1')).toBe('node claude-code');
    expect(stickyForegroundCmd('p1', null)).toBe('node claude-code');
    expect(stickyForegroundCmd('p1', undefined)).toBe('node claude-code');
    expect(stickyForegroundCmd('p1', '')).toBe('node claude-code');
  });

  it('does not clear last-known on an empty remember() — null is unknown, not a shell', () => {
    rememberPaneForegroundCmd('p1', 'cursor-agent');
    rememberPaneForegroundCmd('p1', null);
    rememberPaneForegroundCmd('p1', '  ');
    expect(getPaneForegroundCmd('p1')).toBe('cursor-agent');
  });

  it('updates last-known when a real new command arrives', () => {
    stickyForegroundCmd('p1', 'node claude-code');
    expect(stickyForegroundCmd('p1', 'zsh')).toBe('zsh');
    expect(stickyForegroundCmd('p1', null)).toBe('zsh');
  });

  it('infers cursor-agent from a saved scroll ratio when nothing else is known', () => {
    setPaneScrollRatio('p1', 0.5);
    expect(stickyForegroundCmd('p1', null)).toBe('cursor-agent');
  });

  it('does not invent a command for a pane with no history at all', () => {
    expect(stickyForegroundCmd('fresh', null)).toBeNull();
  });

  it('keeps last-known per pane', () => {
    stickyForegroundCmd('claude-pane', 'node claude-code');
    stickyForegroundCmd('cursor-pane', 'cursor-agent');
    expect(stickyForegroundCmd('claude-pane', null)).toBe('node claude-code');
    expect(stickyForegroundCmd('cursor-pane', null)).toBe('cursor-agent');
  });
});
