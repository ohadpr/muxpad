import { useEffect, useState } from 'react';

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
 * Prototype scope: the mode is client-only (localStorage, per tab id) so we
 * can feel it out with zero server/schema churn. If it earns its keep the
 * natural home is a `tabbed` variant on the LayoutNode itself, persisted like
 * any other layout change. Same shared-store shape as pane-face / tabs caches.
 */
export type TabViewMode = 'split' | 'tabbed';

const DEFAULT: TabViewMode = 'split';
const KEY = 'muxpad.tabViewMode.v1';

type State = Record<string, TabViewMode>;
const listeners = new Map<string, Set<() => void>>();
let cache: State | null = null;

function read(): State {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const out: State = {};
    if (parsed && typeof parsed === 'object') {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === 'tabbed') out[id] = 'tabbed';
      }
    }
    cache = out;
  } catch {
    cache = {};
  }
  return cache;
}

function write(s: State): void {
  cache = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // best-effort (quota / private mode)
  }
}

export function getTabViewMode(tabId: string | null): TabViewMode {
  if (!tabId) return DEFAULT;
  return read()[tabId] ?? DEFAULT;
}

export function setTabViewMode(tabId: string, next: TabViewMode): void {
  const s = { ...read() };
  const prev = s[tabId] ?? DEFAULT;
  if (prev === next) return;
  if (next === DEFAULT) delete s[tabId];
  else s[tabId] = next;
  write(s);
  const subs = listeners.get(tabId);
  if (subs) for (const fn of subs) fn();
}

/** Subscribe-and-read hook. Empty/null id resolves to the default. */
export function useTabViewMode(tabId: string | null): TabViewMode {
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
  return mode;
}
