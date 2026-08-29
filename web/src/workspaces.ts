import type { Workspace } from '@muxpad/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Hook returning the list of top-level workspaces — INCLUDING hidden system
 * workspaces (fetched with ?all=1) so slug lookups resolve for the CEO's
 * workspace-tab route. User-facing enumerations (the nav tree, redirects,
 * move-to targets) must go through visibleWorkspaces(); hidden workspaces
 * are only ever reached via the pinned CEO row or a direct URL.
 *
 * Backed by a module-level cache so the chrome switcher and any other
 * consumers all see the same data. Refreshes on mount, visibility, focus,
 * on a BroadcastChannel ping from another same-browser tab, and on a 5s
 * poll while the tab is visible.
 *
 * The poll is what surfaces per-workspace attention rollups (used by the
 * favicon and the switcher trigger badge) when a background workspace
 * fires BEL — without it, a browser tab parked on Workspace A wouldn't
 * learn that Workspace B has activity until A loses/regains focus.
 * Cross-device sync still piggybacks on the same channel.
 * Components that mutate workspaces should call refreshWorkspaces()
 * directly after the mutation succeeds.
 */
const VISIBLE_POLL_MS = 5000;
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
  const next = await api.listWorkspaces({ all: true });
  if (myVersion < version) return next;
  cache = next;
  for (const fn of listeners) fn(cache);
  if (shouldBroadcast) channel?.postMessage({ type: 'refreshed' });
  return next;
}

/** The workspaces user-facing UI may enumerate — hidden system workspaces
 *  (the CEO's) are excluded; they're reachable only via the pinned CEO row
 *  or a direct URL. */
export function visibleWorkspaces(all: Workspace[]): Workspace[] {
  return all.filter((w) => !w.hidden);
}

/**
 * Optimistically reorder the cached workspaces so the sidebar moves the row
 * immediately, before the reorder round-trip. Bumps `version` so an in-flight
 * poll-refresh (with the old order) is discarded rather than clobbering this;
 * the caller's own refreshWorkspaces() afterwards reconciles with server truth.
 * `ids` covers the VISIBLE set only (the sidebar can't drag what it can't
 * see); hidden workspaces keep their relative order after it. No-op if `ids`
 * doesn't exactly cover the current visible set.
 */
export function applyWorkspaceOrder(ids: string[]): void {
  const byId = new Map(cache.map((w) => [w.id, w]));
  const picked = ids.map((id) => byId.get(id)).filter((w): w is Workspace => w !== undefined);
  if (picked.length !== ids.length) return; // unknown id — stale drag
  const idSet = new Set(ids);
  const rest = cache.filter((w) => !idSet.has(w.id));
  if (rest.some((w) => !w.hidden)) return; // ids didn't cover the visible set
  version++;
  cache = [...picked, ...rest];
  for (const fn of listeners) fn(cache);
}

export function useWorkspaces(): {
  workspaces: Workspace[];
  refresh: () => Promise<Workspace[]>;
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
    const onChannel = (e: MessageEvent) => {
      // Receiver refreshes silently — broadcast: false — so we don't loop.
      if (e.data?.type === 'refreshed') void refreshWorkspaces({ broadcast: false });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    channel?.addEventListener('message', onChannel);
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      startPolling();
    }
    return () => {
      listeners.delete(setState);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      channel?.removeEventListener('message', onChannel);
      stopPolling();
    };
  }, []);
  return { workspaces: state, refresh: refreshWorkspaces };
}
