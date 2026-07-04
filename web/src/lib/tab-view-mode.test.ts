import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTabViewMode, setTabViewMode, syncTabViewMode } from './tab-view-mode';

const patchTab = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock('../api', () => ({ api: { patchTab } }));

const LEGACY_KEY = 'muxpad.tabViewMode.v1';

describe('tab-view-mode store', () => {
  beforeEach(() => {
    localStorage.clear();
    patchTab.mockClear();
    // The module keeps in-memory state across tests; use a fresh tab id per
    // assertion group instead of relying on reset (same as pane-face tests).
  });

  it('defaults to split', () => {
    expect(getTabViewMode('tab-default')).toBe('split');
    expect(getTabViewMode(null)).toBe('split');
  });

  it('setTabViewMode flips locally and PATCHes the server', () => {
    setTabViewMode('tab-set', 'tabbed');
    expect(getTabViewMode('tab-set')).toBe('tabbed');
    expect(patchTab).toHaveBeenCalledWith('tab-set', { view_mode: 'tabbed' });
  });

  it('is a no-op (no PATCH) when the mode is unchanged', () => {
    syncTabViewMode('tab-noop', 'split');
    setTabViewMode('tab-noop', 'split');
    expect(patchTab).not.toHaveBeenCalled();
  });

  it('adopts the server value (another device flipped)', () => {
    syncTabViewMode('tab-adopt', 'tabbed');
    expect(getTabViewMode('tab-adopt')).toBe('tabbed');
    syncTabViewMode('tab-adopt', 'split');
    expect(getTabViewMode('tab-adopt')).toBe('split');
    // Pure adoption never writes back.
    expect(patchTab).not.toHaveBeenCalled();
  });

  it('a fresh local flip outranks a stale server snapshot', () => {
    setTabViewMode('tab-race', 'tabbed');
    // A tab object fetched before the PATCH landed still says 'split' — the
    // optimistic value must survive it.
    syncTabViewMode('tab-race', 'split');
    expect(getTabViewMode('tab-race')).toBe('tabbed');
  });

  it('migrates a legacy localStorage choice up to the server, once', () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ 'tab-legacy': 'tabbed', 'tab-other': 'tabbed' }),
    );
    syncTabViewMode('tab-legacy', 'split'); // server still on the default
    expect(getTabViewMode('tab-legacy')).toBe('tabbed');
    expect(patchTab).toHaveBeenCalledWith('tab-legacy', { view_mode: 'tabbed' });
    // The migrated entry is consumed; the other tab's entry survives.
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '{}')).toEqual({
      'tab-other': 'tabbed',
    });
  });

  it('a deliberate server value beats a legacy leftover', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ 'tab-stale': 'tabbed' }));
    // The server already carries a real (non-default) choice → legacy is
    // consumed but NOT pushed up.
    syncTabViewMode('tab-stale', 'tabbed');
    expect(getTabViewMode('tab-stale')).toBe('tabbed');
    expect(patchTab).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});
