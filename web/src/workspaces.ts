import { useEffect, useState } from 'react';
import type { Workspace } from '@muxpad/shared';
import { api } from './api';

let cache: Workspace[] = [];
const listeners = new Set<(w: Workspace[]) => void>();
let version = 0;

/**
 * Refresh the shared workspace list. Each call fires its own request and
 * is version-tagged so out-of-order responses can't clobber a fresher one.
 *
 * Earlier this function coalesced concurrent calls into a single promise.
 * That created a race: when polling was already in flight and the user
 * clicked a tab, the post-markSeen refresh returned the stale polling
 * promise, and the favicon stayed in its pre-clear state until the next
 * poll. Versioning is correct under any ordering, with the small cost
 * of occasional parallel requests.
 */
export async function refreshWorkspaces(): Promise<void> {
  const myVersion = ++version;
  const next = await api.listWorkspaces();
  if (myVersion < version) return; // a newer call superseded us
  cache = next;
  for (const fn of listeners) fn(cache);
}

/**
 * Returns the latest workspace list and a refresh callback. The list is
 * shared across every component that uses this hook — no duplicate fetches.
 *
 * Auto-refreshes when the document becomes visible or the window regains
 * focus, so a tab opened on one device picks up changes made on another
 * (workspace renamed, created, deleted) when the user comes back to it.
 *
 * Also polls every 5s while the tab is visible. The poll is what surfaces
 * the per-workspace `attention` flag (server-side bell detection) on tabs
 * the user isn't currently looking at.
 */
const VISIBLE_POLL_MS = 5000;

export function useWorkspaces(): {
  workspaces: Workspace[];
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<Workspace[]>(cache);
  useEffect(() => {
    listeners.add(setState);
    void refreshWorkspaces();
    let timer: number | null = null;
    const startPolling = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => void refreshWorkspaces(), VISIBLE_POLL_MS);
    };
    const stopPolling = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshWorkspaces();
        startPolling();
      } else {
        stopPolling();
      }
    };
    const onFocus = () => void refreshWorkspaces();
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
  }, []);
  return { workspaces: state, refresh: refreshWorkspaces };
}
