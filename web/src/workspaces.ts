import { useEffect, useState } from 'react';
import type { Workspace } from '@muxpad/shared';
import { api } from './api';

/**
 * Hook returning the list of top-level workspaces. Backed by a module-
 * level cache so the picker, the chrome switcher, and any other consumers
 * all see the same data. Refreshes on mount, visibility, focus, and on a
 * BroadcastChannel ping from another same-browser tab.
 *
 * No HTTP polling — the workspace list changes slowly compared to per-tab
 * attention state. Same-browser tabs stay in sync via BroadcastChannel
 * (covers the common case of having muxpad open in two tabs on one
 * machine). Cross-device sync still requires an extra trip; deferred.
 * Components that mutate workspaces should call refreshWorkspaces()
 * directly after the mutation succeeds.
 */
let cache: Workspace[] = [];
const listeners = new Set<(w: Workspace[]) => void>();
let version = 0;

// Same-origin tabs share this channel. A successful refresh broadcasts a
// 'refreshed' tick; peers respond by re-fetching (without rebroadcasting,
// so there's no ping-pong loop). BroadcastChannel doesn't deliver to the
// sending tab, which is what we want.
const CHANNEL_NAME = 'muxpad:workspaces';
const channel: BroadcastChannel | null =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

export async function refreshWorkspaces(opts?: { broadcast?: boolean }): Promise<Workspace[]> {
  const shouldBroadcast = opts?.broadcast !== false;
  const myVersion = ++version;
  const next = await api.listWorkspaces();
  if (myVersion < version) return next;
  cache = next;
  for (const fn of listeners) fn(cache);
  if (shouldBroadcast) channel?.postMessage({ type: 'refreshed' });
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
    const onChannel = (e: MessageEvent) => {
      // Receiver refreshes silently — broadcast: false — so we don't loop.
      if (e.data?.type === 'refreshed') void refreshWorkspaces({ broadcast: false });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    channel?.addEventListener('message', onChannel);
    return () => {
      listeners.delete(setState);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      channel?.removeEventListener('message', onChannel);
    };
  }, []);
  return { workspaces: state, refresh: refreshWorkspaces };
}
