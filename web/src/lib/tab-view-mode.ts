import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * How a tab arranges its panes on desktop:
 *   - 'split'  — the react-mosaic tiling (the historical default).
 *   - 'tabbed' — browser-style: one pane visible at a time, chosen from a
 *     horizontal header strip. This is the SAME experience mobile already
 *     forces (only one pane fits a phone), just opt-in on desktop.
 *
 * Crucially this is a *rendering* choice, not a data-model one: both modes
 * render the exact same panes under their stable `key={paneId}`, so flipping
 * between them never unmounts a terminal or touches ptyd — pane sessions keep
 * running untouched (same invariant as a tab switch).
 *
 * The mode is SERVER-persisted (tabs.view_mode, PATCH /api/tabs/:id) so the
 * choice survives reloads and follows the user across devices — same shape as
 * the pane-level terminal/chat view_mode. This module is the client's
 * optimistic overlay: setTabViewMode() flips the in-memory state immediately
 * and PATCHes behind it; useTabViewMode() adopts the server's value (from the
 * tab object, kept live by tab.updated events) unless a local flip is still
 * settling. The old localStorage prototype store is read once per tab purely
 * as a migration source, then dropped.
 */
export type TabViewMode = 'split' | 'tabbed';

const DEFAULT: TabViewMode = 'split';
// The pre-server-persistence store (per-device localStorage). Kept ONLY as a
// one-time migration source: a tab whose server row still has the default but
// was 'tabbed' here keeps its choice (pushed up to the server), after which
// the entry is deleted and the server is the sole source of truth.
const LEGACY_KEY = 'muxpad.tabViewMode.v1';

// How long a local flip outranks an incoming server snapshot. A tab object
// fetched BEFORE our PATCH landed still carries the old mode; adopting it
// would revert the toggle. Our own PATCH echo (tab.updated) carries the new
// mode and reconciles once this window passes.
const LOCAL_WINS_MS = 4000;

const modes = new Map<string, TabViewMode>();
const lastLocalSet = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

function notify(tabId: string): void {
  const subs = listeners.get(tabId);
  if (subs) for (const fn of subs) fn();
}

export function getTabViewMode(tabId: string | null): TabViewMode {
  if (!tabId) return DEFAULT;
  return modes.get(tabId) ?? DEFAULT;
}

/**
 * Pop this tab's entry from the legacy localStorage store (if any). Read-and-
 * delete so the migration runs at most once per tab; only 'tabbed' entries
 * were ever persisted there.
 */
function takeLegacy(tabId: string): TabViewMode | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (!(tabId in record)) return null;
    const value = record[tabId] === 'tabbed' ? 'tabbed' : null;
    delete record[tabId];
    if (Object.keys(record).length === 0) localStorage.removeItem(LEGACY_KEY);
    else localStorage.setItem(LEGACY_KEY, JSON.stringify(record));
    return value;
  } catch {
    return null;
  }
}

/** Flip the mode: optimistic local update + server PATCH (fire-and-forget). */
export function setTabViewMode(tabId: string, next: TabViewMode): void {
  if (getTabViewMode(tabId) === next) return;
  modes.set(tabId, next);
  lastLocalSet.set(tabId, Date.now());
  notify(tabId);
  api.patchTab(tabId, { view_mode: next }).catch((e) => {
    // Keep the optimistic value — the next server snapshot re-syncs if the
    // write really didn't land.
    console.error('failed to persist tab view mode', e);
  });
}

/**
 * Reconcile with the server's value for this tab (from the tab object the
 * page already holds). Server wins — except inside the short window after a
 * local flip, whose PATCH echo will confirm it. A legacy localStorage
 * 'tabbed' choice migrates up the first time the tab is seen with a
 * still-default server row.
 */
export function syncTabViewMode(tabId: string, serverMode: TabViewMode | undefined): void {
  const legacy = takeLegacy(tabId);
  if (legacy === 'tabbed' && (serverMode ?? DEFAULT) === DEFAULT) {
    // One-time migration: this device chose 'tabbed' before the column
    // existed; keep the choice and make it durable.
    setTabViewMode(tabId, 'tabbed');
    return;
  }
  if (!serverMode || serverMode === getTabViewMode(tabId)) return;
  const setAt = lastLocalSet.get(tabId) ?? 0;
  if (Date.now() - setAt < LOCAL_WINS_MS) return;
  modes.set(tabId, serverMode);
  notify(tabId);
}

/**
 * Subscribe-and-read hook. Pass the tab's server-reported view_mode (kept
 * live by tab.updated events) so flips on other devices sync in. Empty/null
 * id resolves to the default.
 */
export function useTabViewMode(
  tabId: string | null,
  serverMode?: TabViewMode | undefined,
): TabViewMode {
  const [mode, setMode] = useState<TabViewMode>(() => getTabViewMode(tabId));
  useEffect(() => {
    setMode(getTabViewMode(tabId));
    if (!tabId) return;
    let subs = listeners.get(tabId);
    if (!subs) {
      subs = new Set();
      listeners.set(tabId, subs);
    }
    const onChange = () => setMode(getTabViewMode(tabId));
    subs.add(onChange);
    return () => {
      subs?.delete(onChange);
      if (subs && subs.size === 0) listeners.delete(tabId);
    };
  }, [tabId]);
  // Adopt the server's value whenever it changes (initial load, tab.updated
  // from another device, our own PATCH echo).
  useEffect(() => {
    if (tabId) syncTabViewMode(tabId, serverMode);
  }, [tabId, serverMode]);
  return mode;
}
