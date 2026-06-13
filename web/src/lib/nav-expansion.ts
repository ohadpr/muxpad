import { useEffect, useState } from 'react';

// Persisted expand/collapse state for the workspace/tab nav tree
// (NavTree). Shared between the desktop sidebar and the mobile bottom
// sheet so the tree reads as ONE surface: collapse a workspace in the
// sidebar and it's collapsed in the sheet too (same browser profile —
// localStorage scope, like settings and last-visited).
//
// Only EXPLICIT user toggles are stored. Effective state falls back to
// "expanded iff this is the active workspace", which is the right first-
// visit default: your current workspace's tabs are visible, everything
// else is a single row.
const KEY = 'muxpad.navExpansion.v1';

type State = Record<string, boolean>; // wsSlug -> explicit expanded/collapsed

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: State = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let current: State = typeof window === 'undefined' ? {} : read();
const listeners = new Set<(s: State) => void>();

export function isExpanded(state: State, wsSlug: string, activeWsSlug: string | null): boolean {
  return state[wsSlug] ?? wsSlug === activeWsSlug;
}

export function toggleExpanded(wsSlug: string, activeWsSlug: string | null): void {
  current = { ...current, [wsSlug]: !isExpanded(current, wsSlug, activeWsSlug) };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // quota exceeded etc. — best-effort, in-memory state still updated
  }
  for (const fn of listeners) fn(current);
}

export function useNavExpansion(): State {
  const [state, setState] = useState<State>(current);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
