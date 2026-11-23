import { useEffect, useState } from 'react';

/**
 * Whether the desktop rail's Unread filter is ON (lib/chat-sections has the
 * rules). One flag, shared by the chip that toggles it and the tree that
 * honours it. Held for the browser session — a filter that came back on by
 * itself days later would be a rail that looks like it lost your chats.
 */
const KEY = 'muxpad.railUnreadFilter.v1';

let on = (() => {
  try {
    return typeof window !== 'undefined' && sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();
const listeners = new Set<(v: boolean) => void>();

export function setRailUnreadFilter(next: boolean): void {
  if (next === on) return;
  on = next;
  try {
    sessionStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    // private mode — in-memory still holds
  }
  for (const fn of listeners) fn(on);
}

export function useRailUnreadFilter(): boolean {
  const [v, setV] = useState(on);
  useEffect(() => {
    listeners.add(setV);
    setV(on);
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}
