import { useEffect, useState } from 'react';
import type { Tab } from '@muxpad/shared';
import { api } from './api';

/**
 * Per-workspace tabs hook. Holds the active workspace's tab list in a
 * module-level cache so the TabBar and TabView render in sync. When
 * `workspaceId` changes (user switches workspaces), the cache is replaced
 * and listeners refire.
 *
 * Auto-refreshes on visibilitychange/focus and polls every 5s while
 * visible. The poll is what surfaces per-tab attention flags (server-side
 * bell detection) on tabs the user isn't actively looking at.
 */
const VISIBLE_POLL_MS = 5000;

let cachedWorkspaceId: string | null = null;
let cache: Tab[] = [];
const listeners = new Set<(t: Tab[]) => void>();
let version = 0;

export async function refreshTabs(workspaceId: string): Promise<void> {
  const myVersion = ++version;
  const next = await api.listTabs(workspaceId);
  if (myVersion < version) return; // a newer call superseded us
  if (cachedWorkspaceId !== workspaceId) cachedWorkspaceId = workspaceId;
  cache = next;
  for (const fn of listeners) fn(cache);
}

export function useTabs(workspaceId: string): {
  tabs: Tab[];
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<Tab[]>(
    cachedWorkspaceId === workspaceId ? cache : [],
  );
  useEffect(() => {
    listeners.add(setState);
    if (cachedWorkspaceId !== workspaceId) {
      cache = [];
      setState(cache);
    }
    void refreshTabs(workspaceId);
    let timer: number | null = null;
    const startPolling = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => void refreshTabs(workspaceId), VISIBLE_POLL_MS);
    };
    const stopPolling = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshTabs(workspaceId);
        startPolling();
      } else {
        stopPolling();
      }
    };
    const onFocus = () => void refreshTabs(workspaceId);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      startPolling();
    }
    return () => {
      listeners.delete(setState);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      stopPolling();
    };
  }, [workspaceId]);
  return { tabs: state, refresh: () => refreshTabs(workspaceId) };
}
