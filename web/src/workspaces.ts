import { useEffect, useState } from 'react';
import type { Workspace } from '@muxpad/shared';
import { api } from './api';

/**
 * Hook returning the list of top-level workspaces. Backed by a module-
 * level cache so the picker, the chrome switcher, and any other consumers
 * all see the same data. Refreshes on visibilitychange/focus.
 *
 * No polling — the workspace list changes slowly compared to per-tab
 * attention state, so we only refresh on natural events (mount, visibility,
 * focus). Components that mutate workspaces should call refreshWorkspaces()
 * directly after the mutation succeeds.
 */
let cache: Workspace[] = [];
const listeners = new Set<(w: Workspace[]) => void>();
let version = 0;

export async function refreshWorkspaces(): Promise<Workspace[]> {
  const myVersion = ++version;
  const next = await api.listWorkspaces();
  if (myVersion < version) return next;
  cache = next;
  for (const fn of listeners) fn(cache);
  return next;
}

export function useWorkspaces(): {
  workspaces: Workspace[];
  refresh: () => Promise<Workspace[]>;
} {
  const [state, setState] = useState<Workspace[]>(cache);
  useEffect(() => {
    listeners.add(setState);
    void refreshWorkspaces();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshWorkspaces();
    };
    const onFocus = () => void refreshWorkspaces();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      listeners.delete(setState);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return { workspaces: state, refresh: refreshWorkspaces };
}
