import { useEffect, useState } from 'react';
import { RAIL_VIEWS, type RailView } from './chat-sections';

/**
 * Which view the desktop chat rail is showing — Home, Unread or Activity (the
 * switcher at its top). One value for the whole rail, not per workspace: it is
 * a way of looking, and switching workspace should not change how you are
 * looking. Held for the browser session.
 */
const KEY = 'muxpad.railView.v1';

let current: RailView = (() => {
  try {
    const v = typeof window !== 'undefined' ? sessionStorage.getItem(KEY) : null;
    return (RAIL_VIEWS as readonly string[]).includes(v ?? '') ? (v as RailView) : 'home';
  } catch {
    return 'home';
  }
})();
const listeners = new Set<(v: RailView) => void>();

export function setRailView(next: RailView): void {
  if (next === current) return;
  current = next;
  try {
    sessionStorage.setItem(KEY, next);
  } catch {
    // private mode — in-memory still holds
  }
  for (const fn of listeners) fn(current);
}

export function useRailView(): RailView {
  const [v, setV] = useState(current);
  useEffect(() => {
    listeners.add(setV);
    setV(current);
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}
